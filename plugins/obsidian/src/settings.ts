import { App, PluginSettingTab, Setting } from "obsidian";
import type AtlasPlugin from "./main";

export interface AtlasSettings {
  baseUrl: string;
  apiKey: string;
}

export const DEFAULT_SETTINGS: AtlasSettings = {
  baseUrl: "",
  apiKey: "",
};

export class AtlasSettingTab extends PluginSettingTab {
  plugin: AtlasPlugin;

  constructor(app: App, plugin: AtlasPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Atlas" });
    containerEl.createEl("p", {
      text: "Connect to your Atlas instance to query your data with natural language.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Atlas URL")
      .setDesc("Base URL of your Atlas instance")
      .addText((text) =>
        text
          .setPlaceholder("https://api.example.com")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.replace(/\/+$/, "");
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc("API key for authentication (leave empty if auth is disabled)")
      .addText((text) => {
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });
  }
}
