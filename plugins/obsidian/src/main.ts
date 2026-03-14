import { Notice, Plugin } from "obsidian";
import { AtlasSettings, DEFAULT_SETTINGS, AtlasSettingTab } from "./settings";
import { QueryModal } from "./query-modal";
import { queryAtlas } from "./client";

interface CachedResult {
  text: string;
  tables: { columns: string[]; rows: Record<string, unknown>[] }[];
}

const MAX_DISPLAY_ROWS = 100;

export default class AtlasPlugin extends Plugin {
  settings!: AtlasSettings;
  private cache = new Map<string, CachedResult>();

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("database", "Ask Atlas", () => {
      new QueryModal(this).open();
    });

    this.addCommand({
      id: "ask",
      name: "Ask a question",
      callback: () => new QueryModal(this).open(),
    });

    this.addSettingTab(new AtlasSettingTab(this.app, this));

    this.registerMarkdownCodeBlockProcessor("atlas", (source, el) => {
      this.renderAtlasBlock(source.trim(), el);
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ── Code block processor ──────────────────────────────────────────

  private renderAtlasBlock(question: string, el: HTMLElement) {
    if (!question) return;

    el.addClass("atlas-block");
    el.createDiv({ cls: "atlas-block-question", text: question });

    const cached = this.cache.get(question);
    if (cached) {
      this.showBlockResult(el, cached);
      const refreshBtn = el.createEl("button", {
        text: "Refresh",
        cls: "atlas-block-btn",
      });
      refreshBtn.addEventListener("click", () => {
        this.cache.delete(question);
        el.empty();
        this.renderAtlasBlock(question, el);
      });
      return;
    }

    const runBtn = el.createEl("button", {
      text: "Run query",
      cls: "atlas-block-btn mod-cta",
    });
    runBtn.addEventListener("click", () =>
      this.runBlockQuery(question, el, runBtn)
    );
  }

  private async runBlockQuery(
    question: string,
    el: HTMLElement,
    runBtn: HTMLButtonElement
  ) {
    const { baseUrl, apiKey } = this.settings;
    if (!baseUrl) {
      new Notice("Configure Atlas in Settings \u2192 Atlas");
      return;
    }

    runBtn.disabled = true;
    runBtn.setText("Running\u2026");

    let text = "";
    const tables: CachedResult["tables"] = [];

    try {
      for await (const event of queryAtlas(baseUrl, apiKey, question)) {
        if (event.type === "text") text += event.text;
        else if (event.type === "result")
          tables.push({ columns: event.columns, rows: event.rows });
        else if (event.type === "error") {
          new Notice(`Atlas: ${event.error}`);
          runBtn.disabled = false;
          runBtn.setText("Run query");
          return;
        }
      }

      this.cache.set(question, { text, tables });
      el.empty();
      this.renderAtlasBlock(question, el);
    } catch (err) {
      new Notice(
        `Atlas: ${err instanceof Error ? err.message : String(err)}`
      );
      runBtn.disabled = false;
      runBtn.setText("Run query");
    }
  }

  private showBlockResult(el: HTMLElement, result: CachedResult) {
    if (result.text) {
      el.createDiv({ cls: "atlas-block-text", text: result.text });
    }

    for (const { columns, rows } of result.tables) {
      const wrapper = el.createDiv({ cls: "atlas-table-wrapper" });
      const table = wrapper.createEl("table", { cls: "atlas-table" });

      const thead = table.createEl("thead");
      const hr = thead.createEl("tr");
      for (const col of columns) hr.createEl("th", { text: col });

      const display = rows.slice(0, MAX_DISPLAY_ROWS);
      const tbody = table.createEl("tbody");
      for (const row of display) {
        const tr = tbody.createEl("tr");
        for (const col of columns)
          tr.createEl("td", { text: String(row[col] ?? "") });
      }

      if (rows.length > MAX_DISPLAY_ROWS) {
        wrapper.createDiv({
          cls: "atlas-table-overflow",
          text: `Showing ${MAX_DISPLAY_ROWS} of ${rows.length} rows`,
        });
      }
    }
  }
}
