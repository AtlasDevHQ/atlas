/**
 * Shared Python wrapper fragments for data analysis sandboxes.
 *
 * Both python-nsjail.ts and python-sandbox.ts compose their full wrapper
 * scripts from these shared fragments, eliminating code duplication.
 * The sidecar (packages/sandbox-sidecar) maintains its own copy since
 * it runs as a standalone container.
 */

/**
 * Shared security guard + environment setup.
 *
 * Expects the caller to have already imported: sys, json, os, ast
 *
 * Expects the caller to have already defined:
 * - _chart_dir: str — path to chart output directory
 * - _report_error(msg: str) — emit error and exit the process
 *
 * Enforces the AST-based import guard (exits via _report_error on violation),
 * configures a headless matplotlib backend, ensures _chart_dir exists,
 * and makes available: _user_code, chart_path().
 */
export const PYTHON_SECURITY_AND_SETUP = `# --- Import guard (AST-based enforcement) ---
_BLOCKED_MODULES = {
    "subprocess", "os", "socket", "shutil", "sys", "ctypes", "importlib",
    "code", "signal", "multiprocessing", "threading", "pty", "fcntl",
    "termios", "resource", "posixpath",
    "http", "urllib", "requests", "httpx", "aiohttp", "webbrowser",
    "pickle", "tempfile", "pathlib",
}
_BLOCKED_BUILTINS = {
    "compile", "exec", "eval", "__import__", "open", "breakpoint",
    "getattr", "globals", "locals", "vars", "dir", "delattr", "setattr",
}

_user_code = open(sys.argv[1]).read()
try:
    _tree = ast.parse(_user_code)
except SyntaxError as e:
    _report_error(f"SyntaxError: {e.msg} (line {e.lineno})")

_blocked = None
for _node in ast.walk(_tree):
    if _blocked:
        break
    if isinstance(_node, ast.Import):
        for _alias in _node.names:
            _mod = _alias.name.split('.')[0]
            if _mod in _BLOCKED_MODULES:
                _blocked = f'Blocked import: "{_mod}" is not allowed'
                break
    elif isinstance(_node, ast.ImportFrom):
        if _node.module:
            _mod = _node.module.split('.')[0]
            if _mod in _BLOCKED_MODULES:
                _blocked = f'Blocked import: "{_mod}" is not allowed'
    elif isinstance(_node, ast.Call):
        _name = None
        if isinstance(_node.func, ast.Name):
            _name = _node.func.id
        elif isinstance(_node.func, ast.Attribute):
            _name = _node.func.attr
        if _name and _name in _BLOCKED_BUILTINS:
            _blocked = f'Blocked builtin: "{_name}()" is not allowed'

if _blocked:
    _report_error(_blocked)

# Configure matplotlib for headless rendering
try:
    import matplotlib
    matplotlib.use('Agg')
except ImportError:
    pass

os.makedirs(_chart_dir, exist_ok=True)  # no-op if pre-created by host (e.g. nsjail bind-mount)

def chart_path(n=0):
    return os.path.join(_chart_dir, f"chart_{n}.png")`;

/**
 * Non-streaming execution: stdout capture, exec, result collection.
 *
 * Expects: sys, json, io, base64, glob, os imported;
 * _marker, _chart_dir, _user_code, data, df, chart_path defined.
 *
 * Captures stdout, executes user code in an isolated namespace, collects
 * charts and structured results, and emits a single JSON result via _marker.
 */
export const PYTHON_EXEC_AND_COLLECT = `# --- Execute user code in isolated namespace ---
_old_stdout = sys.stdout
sys.stdout = _captured = io.StringIO()

_user_ns = {"chart_path": chart_path, "data": data, "df": df}
_atlas_error = None
try:
    exec(_user_code, _user_ns)
except Exception as e:
    _atlas_error = f"{type(e).__name__}: {e}"

_output = _captured.getvalue()
sys.stdout = _old_stdout

# --- Collect results ---
_charts = []
for f in sorted(glob.glob(os.path.join(_chart_dir, "chart_*.png"))):
    with open(f, "rb") as fh:
        _charts.append({"base64": base64.b64encode(fh.read()).decode(), "mimeType": "image/png"})

_result = {"success": _atlas_error is None}
if _output.strip():
    _result["output"] = _output.strip()
if _atlas_error:
    _result["error"] = _atlas_error

if "_atlas_table" in _user_ns:
    _result["table"] = _user_ns["_atlas_table"]

if "_atlas_chart" in _user_ns:
    _ac = _user_ns["_atlas_chart"]
    if isinstance(_ac, dict):
        _result["rechartsCharts"] = [_ac]
    elif isinstance(_ac, list):
        _result["rechartsCharts"] = _ac

if _charts:
    _result["charts"] = _charts

print(_marker + json.dumps(_result), file=_old_stdout)`;

/**
 * Complete, self-contained Python wrapper using **file transport** for both
 * the data payload in and the structured result out (#3414).
 *
 * This is the wrapper the Vercel Python backend has always used; it is hoisted
 * here because the BYOC plugin providers (e2b, daytona — #4665) must run the
 * *same* script. A plugin that shipped its own copy would be shipping its own
 * copy of the in-sandbox import guard, and the copies would drift silently:
 * the host is the only place that can guarantee every provider executes the
 * identical guard, so the host hands the source down rather than trusting each
 * plugin to carry it (`PluginPythonOptions.wrapperSource`).
 *
 * Result transport diverges from {@link PYTHON_EXEC_AND_COLLECT} (used by the
 * nsjail and sidecar backends): instead of smuggling the structured result back
 * through a `__ATLAS_RESULT_<id>__` stdout marker, this wrapper writes result
 * JSON to `$ATLAS_RESULT_FILE` and leaves chart PNGs as `chart_*.png` files in
 * `$ATLAS_CHART_DIR`. The host reads both off the sandbox filesystem and
 * base64-encodes charts host-side. That split is what lets a provider whose
 * shell surface mangles or truncates stdout still return charts intact.
 *
 * **Invocation contract** — a backend running this wrapper MUST:
 *
 *   `python3 <wrapper.py> <user_code.py> [<data.json>]`
 *
 * with `ATLAS_RESULT_FILE` (absolute path to write result JSON to) and
 * `ATLAS_CHART_DIR` (absolute path of the chart output directory) set in the
 * environment, plus `MPLBACKEND=Agg` for headless matplotlib. `data.json`, when
 * present, holds `{ columns, rows }`. The wrapper always exits 0 on a Python-level
 * error — the error rides in the result JSON — so a non-zero exit code from the
 * interpreter means the process died before the wrapper could report, and the
 * backend should fall back to stderr.
 */
export const PYTHON_FILE_TRANSPORT_WRAPPER = `
import sys, json, io, os, ast

_chart_dir = os.environ.get("ATLAS_CHART_DIR", "/tmp/charts")
_result_file = os.environ["ATLAS_RESULT_FILE"]

def _report_error(msg):
    with open(_result_file, "w") as _rf:
        _rf.write(json.dumps({"success": False, "error": msg}))
    sys.exit(0)

${PYTHON_SECURITY_AND_SETUP}

# --- Data injection (from file, not stdin) ---
_atlas_data = None
if len(sys.argv) > 2:
    _data_file = sys.argv[2]
    if os.path.exists(_data_file):
        with open(_data_file) as f:
            _raw = f.read().strip()
            if _raw:
                _atlas_data = json.loads(_raw)

data = None
df = None
if _atlas_data:
    try:
        import pandas as pd
        df = pd.DataFrame(_atlas_data["rows"], columns=_atlas_data["columns"])
        data = df
    except ImportError:
        data = _atlas_data

# --- Execute user code in isolated namespace ---
_old_stdout = sys.stdout
sys.stdout = _captured = io.StringIO()

_user_ns = {"chart_path": chart_path, "data": data, "df": df}
_atlas_error = None
try:
    exec(_user_code, _user_ns)
except Exception as e:
    _atlas_error = f"{type(e).__name__}: {e}"

_output = _captured.getvalue()
sys.stdout = _old_stdout

# --- Build structured result (charts stay as PNG files, read host-side) ---
_result = {"success": _atlas_error is None}
if _output.strip():
    _result["output"] = _output.strip()
if _atlas_error:
    _result["error"] = _atlas_error

if "_atlas_table" in _user_ns:
    _result["table"] = _user_ns["_atlas_table"]

if "_atlas_chart" in _user_ns:
    _ac = _user_ns["_atlas_chart"]
    if isinstance(_ac, dict):
        _result["rechartsCharts"] = [_ac]
    elif isinstance(_ac, list):
        _result["rechartsCharts"] = _ac

with open(_result_file, "w") as _rf:
    _rf.write(json.dumps(_result))
`;

/**
 * Environment variable names and the chart filename pattern that
 * {@link PYTHON_FILE_TRANSPORT_WRAPPER} reads and writes. Exported so the
 * backends that run the wrapper — in-tree and plugin-provided alike — bind to
 * one definition instead of three string literals that can drift apart.
 */
export const PYTHON_FILE_TRANSPORT = {
  /** Env var naming the absolute path the wrapper writes result JSON to. */
  resultFileEnv: "ATLAS_RESULT_FILE",
  /** Env var naming the absolute chart output directory. */
  chartDirEnv: "ATLAS_CHART_DIR",
  /** Charts the host collects from the chart directory, in sorted order. */
  chartPattern: /^chart_.*\.png$/,
  /**
   * Environment every backend running this wrapper must set beyond the two
   * path vars: headless matplotlib, a writable HOME, and a UTF-8 locale.
   * Defined once so a backend cannot get the trio subtly wrong — a missing
   * MPLBACKEND turns every chart into a crash inside a sandbox with no display.
   */
  baseEnv: {
    MPLBACKEND: "Agg",
    HOME: "/tmp",
    LANG: "C.UTF-8",
  },
} as const;
