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
