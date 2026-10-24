"use client";

import { ChevronRight } from "lucide-react";
import { useExtracted } from "next-intl";
import { parseCityValue, useGetRegionName } from "../../../../../lib/geo";
import { getCountryName } from "../../../../../lib/utils";
import { CountryFlag } from "../../../components/shared/icons/CountryFlag";
import { BotSectionTabs, type BotSectionTab } from "../BotSectionTabs";

type Tab = "countries" | "regions" | "cities";

export function BotCountries() {
  const t = useExtracted();
  const { getRegionName } = useGetRegionName();

  const tabs: BotSectionTab<Tab>[] = [
    {
      value: "countries",
      label: t("Countries"),
      section: {
        dimension: "country",
        title: t("Countries"),
        getValue: item => item.value,
        getKey: item => item.value || "unknown",
        getLabel: item => (
          <div className="flex gap-2 items-center">
            {item.value && <CountryFlag country={item.value} />}
            {item.value ? getCountryName(item.value) : t("Unknown")}
          </div>
        ),
      },
    },
    {
      value: "regions",
      label: t("Regions"),
      section: {
        dimension: "region",
        title: t("Regions"),
        getValue: item => item.value,
        getKey: item => item.value || "unknown",
        getLabel: item => {
          if (!item.value) return t("Unknown");
          const countryCode = item.value.split("-")[0];

          return (
            <div className="flex gap-2 items-center">
              <CountryFlag country={countryCode} />
              {countryCode}
              <ChevronRight className="w-4 h-4 mx-[-4px]" />
              {getRegionName(item.value) || item.value.slice(3)}
            </div>
          );
        },
      },
    },
    {
      value: "cities",
      label: t("Cities"),
      section: {
        dimension: "city",
        title: t("Cities"),
        getValue: item => item.value,
        getKey: item => item.value || "unknown",
        getLabel: item => {
          if (!item.value || item.value === "-") return t("Unknown");
          const { country, region, city } = parseCityValue(item.value);
          const regionName = getRegionName(`${country}-${region}`);

          return (
            <div className="flex gap-2 items-center">
              <CountryFlag country={country} />
              {country}
              {regionName && <ChevronRight className="w-4 h-4 mx-[-4px]" />}
              {regionName}
              {city && <ChevronRight className="w-4 h-4 mx-[-4px]" />}
              {city}
            </div>
          );
        },
      },
    },
  ];

  return <BotSectionTabs defaultValue="countries" tabs={tabs} />;
}
