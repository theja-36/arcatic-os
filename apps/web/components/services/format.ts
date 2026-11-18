export const stageTone = (s: string) => (s === "delivered" ? "warning" : s === "approved" ? "success" : s === "cancelled" ? "danger" : "neutral");
export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft", submitted: "Waiting for assignment", assigned: "Assigned", in_progress: "In progress", in_review: "In QA",
  delivered: "Delivered", revision_requested: "Revision requested", approved: "Approved", cancelled: "Cancelled",
};
export const when = (iso: string) => new Date(iso).toLocaleString();
export const fileSize = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
