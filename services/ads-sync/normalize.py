"""Pure row normalisers (no SDK imports) so they can be unit-tested without credentials."""
from __future__ import annotations

# Meta action types counted as conversions. These are the standard event names; an account that
# optimises for a custom conversion will report it under its own action_type and is NOT counted here.
META_CONVERSION_ACTIONS = {"purchase", "lead", "complete_registration", "offsite_conversion.fb_pixel_purchase", "offsite_conversion.fb_pixel_lead"}


def _num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def google_row(row) -> dict:
    """GoogleAdsRow (campaign, segments.date, metrics.*) → AdCampaignDay. cost_micros: 1 unit = 1e6 micros."""
    m = row.metrics
    return {
        "date": str(row.segments.date),
        "campaignId": str(row.campaign.id),
        "campaignName": str(row.campaign.name),
        "impressions": int(m.impressions or 0),
        "clicks": int(m.clicks or 0),
        "costMinor": int(round(int(m.cost_micros or 0) / 10_000)),
        "conversions": int(round(_num(m.conversions))),
        "conversionValueMinor": int(round(_num(m.conversions_value) * 100)),
        "videoViews": int(m.video_trueview_views or 0),
        "reach": None,
    }


def _sum_actions(actions, wanted=None) -> float:
    total = 0.0
    for a in actions or []:
        kind = a.get("action_type") if isinstance(a, dict) else getattr(a, "action_type", None)
        value = a.get("value") if isinstance(a, dict) else getattr(a, "value", None)
        if wanted is None or kind in wanted:
            total += _num(value)
    return total


def meta_row(r: dict) -> dict:
    """AdsInsights (level=campaign, time_increment=1) → AdCampaignDay. spend is a decimal string in account currency."""
    return {
        "date": str(r.get("date_start")),
        "campaignId": str(r.get("campaign_id")),
        "campaignName": str(r.get("campaign_name") or ""),
        "impressions": int(_num(r.get("impressions"))),
        "clicks": int(_num(r.get("clicks"))),
        "costMinor": int(round(_num(r.get("spend")) * 100)),
        "conversions": int(round(_sum_actions(r.get("actions"), META_CONVERSION_ACTIONS))),
        "conversionValueMinor": int(round(_sum_actions(r.get("action_values"), META_CONVERSION_ACTIONS) * 100)),
        "videoViews": int(_sum_actions(r.get("video_play_actions"))),
        "reach": int(_num(r.get("reach"))) if r.get("reach") is not None else None,
    }
