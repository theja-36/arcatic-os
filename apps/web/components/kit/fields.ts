export type FieldKind = "text" | "short" | "list" | "colors" | "fonts" | "contact" | "url";

export interface FieldDef {
  path: string;
  label: string;
  kind: FieldKind;
  help?: string;
}

export const TABS: Array<{ id: string; label: string; fields?: FieldDef[] }> = [
  {
    id: "profile",
    label: "Profile",
    fields: [
      { path: "oneLiner", label: "One-line description", kind: "short", help: "What you do, for whom, in one sentence (max 200 characters)." },
      { path: "profile.businessType", label: "Business type", kind: "short" },
      { path: "profile.industry", label: "Industry", kind: "short" },
      { path: "profile.location", label: "Location", kind: "short" },
      { path: "profile.serviceArea", label: "Service area", kind: "short" },
      { path: "profile.contact", label: "Contact details", kind: "contact" },
      { path: "positioning", label: "Positioning", kind: "text", help: "Why customers choose you over the alternatives." },
      { path: "mission", label: "Mission", kind: "text" },
      { path: "vision", label: "Vision", kind: "text" },
      { path: "differentiators", label: "Differentiators", kind: "list" },
      { path: "proofPoints", label: "Proof points", kind: "list", help: "Facts you can back up: years in business, customers served, certifications." },
      { path: "objections", label: "Common objections", kind: "list" },
      { path: "competitors", label: "Competitors", kind: "list" },
    ],
  },
  { id: "audiences", label: "Audience" },
  { id: "offers", label: "Offers" },
  {
    id: "voice",
    label: "Voice",
    fields: [
      { path: "voice.tone", label: "Tone", kind: "list" },
      { path: "voice.personality", label: "Personality", kind: "list" },
      { path: "voice.emotions", label: "Emotions to evoke", kind: "list" },
      { path: "voice.syntax", label: "Sentence style", kind: "list", help: "e.g. Short sentences. Speak to the reader as 'you'." },
      { path: "voice.do", label: "Always", kind: "list" },
      { path: "voice.dont", label: "Never", kind: "list" },
      { path: "vocabulary.preferred", label: "Preferred words", kind: "list" },
      { path: "vocabulary.banned", label: "Banned words", kind: "list", help: "Checked automatically on every draft, in every language." },
    ],
  },
  {
    id: "visual",
    label: "Visuals",
    fields: [
      { path: "visual.colors", label: "Colours", kind: "colors" },
      { path: "visual.fonts", label: "Fonts", kind: "fonts" },
      { path: "visual.logoUrl", label: "Logo URL", kind: "url" },
      { path: "visual.imageryStyle", label: "Imagery style", kind: "text" },
      { path: "visual.layoutRules", label: "Layout rules", kind: "list" },
    ],
  },
  {
    id: "channels",
    label: "Channels & rules",
    fields: [
      { path: "marketing.goals", label: "Marketing goals", kind: "list" },
      { path: "marketing.channels", label: "Channels", kind: "list" },
      { path: "marketing.maturity", label: "Marketing maturity", kind: "short" },
      { path: "channelRules.instagram", label: "Instagram rules", kind: "list" },
      { path: "channelRules.facebook", label: "Facebook rules", kind: "list" },
      { path: "channelRules.linkedin", label: "LinkedIn rules", kind: "list" },
      { path: "channelRules.x", label: "X rules", kind: "list" },
      { path: "channelRules.youtube", label: "YouTube rules", kind: "list" },
      { path: "channelRules.email", label: "Email rules", kind: "list" },
      { path: "compliance.disclaimers", label: "Required disclaimers", kind: "list", help: "Every draft must contain these exactly." },
    ],
  },
  { id: "history", label: "History" },
];

export const LANGUAGES: Record<string, string> = { en: "English", te: "తెలుగు (Telugu)", hi: "हिन्दी (Hindi)", ta: "தமிழ் (Tamil)", kn: "ಕನ್ನಡ (Kannada)" };
