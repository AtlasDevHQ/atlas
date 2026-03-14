import { MarkdownView, Modal, Notice } from "obsidian";
import type AtlasPlugin from "./main";
import { queryAtlas, resultToMarkdown, type ResultEvent } from "./client";

const MAX_DISPLAY_ROWS = 100;

export class QueryModal extends Modal {
  private plugin: AtlasPlugin;
  private inputEl!: HTMLTextAreaElement;
  private resultEl!: HTMLDivElement;
  private askBtn!: HTMLButtonElement;
  private insertBtn!: HTMLButtonElement;
  private responseText = "";
  private tableResults: ResultEvent[] = [];
  private querying = false;

  constructor(plugin: AtlasPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("atlas-modal");

    contentEl.createEl("h2", { text: "Ask Atlas" });

    this.inputEl = contentEl.createEl("textarea", {
      cls: "atlas-input",
      attr: { placeholder: "Ask a question about your data\u2026", rows: "3" },
    });

    const btnRow = contentEl.createDiv({ cls: "atlas-btn-row" });

    this.askBtn = btnRow.createEl("button", { text: "Ask", cls: "mod-cta" });
    this.askBtn.addEventListener("click", () => this.runQuery());

    this.insertBtn = btnRow.createEl("button", { text: "Insert into note" });
    this.insertBtn.style.display = "none";
    this.insertBtn.addEventListener("click", () => this.insertResult());

    this.resultEl = contentEl.createDiv({ cls: "atlas-results" });

    this.inputEl.focus();
    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.runQuery();
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }

  private async runQuery() {
    const question = this.inputEl.value.trim();
    if (!question || this.querying) return;

    const { baseUrl, apiKey } = this.plugin.settings;
    if (!baseUrl) {
      new Notice("Configure your Atlas URL in Settings \u2192 Atlas");
      return;
    }

    this.querying = true;
    this.askBtn.disabled = true;
    this.askBtn.setText("Thinking\u2026");
    this.insertBtn.style.display = "none";
    this.responseText = "";
    this.tableResults = [];
    this.resultEl.empty();

    const textEl = this.resultEl.createDiv({ cls: "atlas-response-text" });

    try {
      for await (const event of queryAtlas(baseUrl, apiKey, question)) {
        switch (event.type) {
          case "text":
            this.responseText += event.text;
            textEl.setText(this.responseText);
            break;
          case "result":
            this.tableResults.push(event);
            this.renderTable(this.resultEl, event.columns, event.rows);
            break;
          case "error":
            this.resultEl.createDiv({ cls: "atlas-error", text: event.error });
            break;
        }
      }

      if (this.responseText || this.tableResults.length > 0) {
        this.insertBtn.style.display = "";
      }
    } catch (err) {
      this.resultEl.createDiv({
        cls: "atlas-error",
        text: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      this.querying = false;
      this.askBtn.disabled = false;
      this.askBtn.setText("Ask");
    }
  }

  private renderTable(
    parent: HTMLElement,
    columns: string[],
    rows: Record<string, unknown>[]
  ) {
    const wrapper = parent.createDiv({ cls: "atlas-table-wrapper" });
    const table = wrapper.createEl("table", { cls: "atlas-table" });

    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    for (const col of columns) {
      headerRow.createEl("th", { text: col });
    }

    const display = rows.slice(0, MAX_DISPLAY_ROWS);
    const tbody = table.createEl("tbody");
    for (const row of display) {
      const tr = tbody.createEl("tr");
      for (const col of columns) {
        tr.createEl("td", { text: String(row[col] ?? "") });
      }
    }

    if (rows.length > MAX_DISPLAY_ROWS) {
      wrapper.createDiv({
        cls: "atlas-table-overflow",
        text: `Showing ${MAX_DISPLAY_ROWS} of ${rows.length} rows`,
      });
    }
  }

  private insertResult() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.editor) {
      new Notice("No active editor");
      return;
    }

    const question = this.inputEl.value.trim();
    let md = `\n**Q:** ${question}\n\n`;

    if (this.responseText) {
      md += `${this.responseText}\n\n`;
    }

    for (const r of this.tableResults) {
      md += `${resultToMarkdown(r.columns, r.rows)}\n\n`;
    }

    view.editor.replaceSelection(md);
    this.close();
    new Notice("Atlas result inserted");
  }
}
