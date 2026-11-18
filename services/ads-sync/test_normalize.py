import unittest
from types import SimpleNamespace as NS

from normalize import google_row, meta_row


class NormalizeTest(unittest.TestCase):
    def test_google_micros_to_minor_units(self):
        row = NS(segments=NS(date="2026-11-15"), campaign=NS(id=123, name="Diwali"),
                 metrics=NS(impressions=1000, clicks=40, cost_micros=1_234_560_000, conversions=3.6, conversions_value=1499.5, video_trueview_views=0))
        r = google_row(row)
        self.assertEqual(r["costMinor"], 123456)          # 1,234.56 → 123456 paise
        self.assertEqual(r["conversions"], 4)
        self.assertEqual(r["conversionValueMinor"], 149950)
        self.assertEqual(r["campaignId"], "123")

    def test_meta_spend_actions_and_views(self):
        r = meta_row({"date_start": "2026-11-15", "campaign_id": "9", "campaign_name": "Reels", "impressions": "5000", "clicks": "120", "spend": "250.75", "reach": "4100",
                      "actions": [{"action_type": "link_click", "value": "120"}, {"action_type": "purchase", "value": "3"}, {"action_type": "lead", "value": "2"}],
                      "action_values": [{"action_type": "purchase", "value": "2997"}], "video_play_actions": [{"action_type": "video_view", "value": "800"}]})
        self.assertEqual(r["costMinor"], 25075)
        self.assertEqual(r["conversions"], 5)              # link clicks are not conversions
        self.assertEqual(r["conversionValueMinor"], 299700)
        self.assertEqual(r["videoViews"], 800)
        self.assertEqual(r["reach"], 4100)

    def test_meta_missing_fields(self):
        r = meta_row({"date_start": "2026-11-15", "campaign_id": "9"})
        self.assertEqual((r["impressions"], r["costMinor"], r["conversions"], r["reach"]), (0, 0, 0, None))


if __name__ == "__main__":
    unittest.main()
