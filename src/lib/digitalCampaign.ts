export const DIGITAL_STANDARD = "digitalads-niat_guru_ratna-";

export const DIGITAL_CHANNELS = [
  "google",
  "meta",
  "mediabuying",
  "whatsapp",
  "sms",
  "sharechat",
  "paytm",
  "josh",
  "turecaller",
  "gpay",
  "mygate",
  "jiohotstar",
  "email",
  "meta_fbinsta",
  "google_nbsearch",
  "google_dgen",
  "snapchat",
  "google_yt",
  "google_display",
  "meta_insta",
  "rcs",
  "google_pmax",
  "google_bs",
  "meta_ctwa",
  "generic-",
  "taboola-",
  "manabadi-",
  "sales",
] as const;

export const DIGITAL_STATES = [
  "ap-",
  "apts-",
  "ts-",
  "ka-",
  "kl-",
  "tn-",
  "wb-",
  "india-",
  "mh-",
  "tn_pudu-",
  "delhi-",
  "hindi_fr-",
  "hindi_fr_city-",
  "south-",
  "non_south-",
  "rj-",
  "ncr-",
  "hyd-",
  "jaipur-",
  "non_telugu-",
  "hindi_region-",
  "odisha-",
  "english_region-",
  "up-",
  "mp-",
  "pb-",
  "gj-",
  "jh-",
  "bihar-",
  "haryana-",
  "cg-",
  "ut-",
] as const;

export const DIGITAL_LANGUAGES = [
  "telugu-",
  "hindi-",
  "tamil-",
  "kannada-",
  "bengali-",
  "english-",
  "marathi-",
  "malayalam-",
] as const;

export const DIGITAL_CREATIVE_TYPES = [
  "-influ",
  "-testi",
  "-motion",
  "-poster",
  "-memoji",
  "-spokesperson",
  "-conceptads",
  "-text",
  "-carousel",
  "-carousel-posters",
  "-testi_spokesperson",
  "-concept_spokesperson",
  "-video",
  "-podcast",
  "-ctwa",
] as const;

export const DIGITAL_MEDIUMS = [
  "pmax",
  "youtube",
  "facebook",
  "instagram",
  "fbinsta",
  "searchads",
  "display",
  "1000reach",
  "primedigital",
  "universityupdates",
  "demandgen",
  "leadgen",
  "remarketing_presales",
  "affinity",
  "examupdts",
  "sharechat",
  "moj",
  "stucor",
  "lokalapp",
  "jio",
  "freshersworld",
  "karix",
  "phonepe",
  "taboola",
  "mediaant",
  "work4freshers",
  "intandtrainings",
  "ctwa",
  "justdial",
  "nbsearch",
  "msgsequence",
  "instantform",
  "awareness",
] as const;

export const DIGITAL_LANDING_PAGES = [
  { destination: "/", token: "home" },
  { destination: "/nominate-student", token: "student" },
  { destination: "/nominate-teacher", token: "teacher" },
] as const;

export const DIGITAL_LANDING_TOKENS = DIGITAL_LANDING_PAGES.map((p) => p.token);

export const DIGITAL_DESTINATIONS = DIGITAL_LANDING_PAGES.map((p) => p.destination);

export type DigitalChannel = (typeof DIGITAL_CHANNELS)[number];
export type DigitalState = (typeof DIGITAL_STATES)[number];
export type DigitalLanguage = (typeof DIGITAL_LANGUAGES)[number];
export type DigitalCreativeType = (typeof DIGITAL_CREATIVE_TYPES)[number];
export type DigitalMedium = (typeof DIGITAL_MEDIUMS)[number];
export type DigitalLandingToken = (typeof DIGITAL_LANDING_PAGES)[number]["token"];
export type DigitalDestination = (typeof DIGITAL_LANDING_PAGES)[number]["destination"];

export const isDigitalChannel = (value: string): value is DigitalChannel =>
  (DIGITAL_CHANNELS as readonly string[]).includes(value);

export const isDigitalState = (value: string): value is DigitalState =>
  (DIGITAL_STATES as readonly string[]).includes(value);

export const isDigitalLanguage = (value: string): value is DigitalLanguage =>
  (DIGITAL_LANGUAGES as readonly string[]).includes(value);

export const isDigitalCreativeType = (value: string): value is DigitalCreativeType =>
  (DIGITAL_CREATIVE_TYPES as readonly string[]).includes(value);

export const isDigitalMedium = (value: string): value is DigitalMedium =>
  (DIGITAL_MEDIUMS as readonly string[]).includes(value);

export const isDigitalDestination = (value: string): value is DigitalDestination =>
  (DIGITAL_DESTINATIONS as readonly string[]).includes(value);

export const isDigitalLandingToken = (value: string): value is DigitalLandingToken =>
  (DIGITAL_LANDING_TOKENS as readonly string[]).includes(value);

export const landingTokenToDestination = (token: string): DigitalDestination =>
  DIGITAL_LANDING_PAGES.find((p) => p.token === token)?.destination ?? "/nominate-student";

export const slugifyDigitalField = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

export const channelToUtmSource = (channel: string) => channel.trim().toLowerCase();

export const joinCampaignParts = (parts: string[]) =>
  parts
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      if (!acc) return part;
      const needHyphen = !acc.endsWith("-") && !part.startsWith("-");
      return needHyphen ? `${acc}-${part}` : `${acc}${part}`;
    }, "");

export type DigitalCampaignFields = {
  channel: string;
  state: string;
  language: string;
  audience?: string;
  landingDiff?: string;
  creativeType: string;
  creative?: string;
};

export const buildFinalUtmCampaign = (fields: DigitalCampaignFields) =>
  joinCampaignParts([
    DIGITAL_STANDARD,
    fields.channel,
    fields.state,
    fields.language,
    slugifyDigitalField(fields.audience || ""),
    slugifyDigitalField(fields.landingDiff || ""),
    fields.creativeType,
    slugifyDigitalField(fields.creative || ""),
  ]);
