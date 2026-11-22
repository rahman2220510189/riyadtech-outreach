import type { Metadata } from "next";
import { DataSources } from "@/components/finder/DataSources";
import { CategoriesSettings } from "@/components/settings/CategoriesSettings";
import { CountriesSettings } from "@/components/settings/CountriesSettings";
import { CrawlerSettings, ScoreSettings } from "@/components/settings/CrawlerSettings";
import { CompanySettings, SendingSettings } from "@/components/settings/MailSettings";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 max-w-prose text-ink-2">
          Your company and e-mail footer, sending limits, markets, categories, the website crawler and lead scores.
        </p>
      </div>
      <CompanySettings />
      <SendingSettings />
      <CountriesSettings />
      <CategoriesSettings />
      <CrawlerSettings />
      <ScoreSettings />
      <DataSources />
    </div>
  );
}
