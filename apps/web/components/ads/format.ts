export const money = (minor: number | null | undefined, currency = "INR") =>
  minor == null ? "—" : `${currency === "INR" ? "₹" : `${currency} `}${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
export const statusTone = (s: string) => (s === "active" ? "success" : s === "failed" ? "danger" : s === "launching" ? "warning" : "neutral");
export const OBJECTIVES = { google: { website_traffic: "Website traffic (Search)" }, meta: { traffic: "Traffic (link clicks)", awareness: "Awareness (reach)" } } as const;
