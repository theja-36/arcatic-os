import unittest

from build import google_plan, meta_plan, tag_name

BASE = {"id": "6f1c2a9e-0000-4000-8000-000000000001", "name": "Diwali search", "dailyBudgetMinor": 50000, "landingUrl": "https://example.in/diwali", "currency": "INR"}
GOOGLE = {**BASE, "creative": {"headlines": ["One", "Two", "Three"], "descriptions": ["Desc one", "Desc two"], "path1": "diwali"},
          "audience": {"keywords": [{"text": "diwali hampers", "match": "EXACT"}, {"text": "gift box", "match": "WEIRD"}], "locations": [{"key": "2356", "name": "India", "type": "country"}, {"key": "IN", "type": "country"}], "languageIds": ["1000"], "negativeKeywords": ["free"]},
          "startDate": "2026-11-20", "endDate": "2026-12-01"}
META = {**BASE, "objective": "traffic", "pageId": "1234567890", "imageUrl": "https://cdn.example.in/a.jpg",
        "creative": {"primaryText": "Hampers your team will love.", "headline": "Diwali hampers", "cta": "SHOP_NOW"},
        "audience": {"locations": [{"key": "IN", "type": "country"}, {"key": "1035921", "type": "city"}], "ageMin": 25, "ageMax": 45, "genders": ["female"], "interests": [{"id": "6003", "name": "Gifts"}]}}


class GooglePlan(unittest.TestCase):
    def test_plan(self):
        p = google_plan(GOOGLE)
        self.assertEqual(p["name"], "Diwali search [arc:6f1c2a9e]")
        self.assertEqual(p["budget"]["amount_micros"], 500_000_000)
        self.assertEqual(p["start"], "20261120 00:00:00")
        self.assertEqual(p["end"], "20261201 23:59:59")
        self.assertEqual(p["locations"], ["2356"])  # only numeric geo target ids
        self.assertEqual([k["match"] for k in p["keywords"]], ["EXACT", "PHRASE"])
        self.assertEqual(p["ad"]["path2"], None)

    def test_rejects_incomplete(self):
        for bad in ({**GOOGLE, "creative": {"headlines": ["a", "b"], "descriptions": ["x", "y"]}}, {**GOOGLE, "landingUrl": "http://x"}, {**GOOGLE, "dailyBudgetMinor": 0}, {**GOOGLE, "audience": {**GOOGLE["audience"], "keywords": []}}):
            with self.assertRaises(ValueError):
                google_plan(bad)


class MetaPlan(unittest.TestCase):
    def test_plan(self):
        p = meta_plan(META)
        self.assertEqual(p["campaign"]["status"], "PAUSED")
        self.assertEqual(p["campaign"]["objective"], "OUTCOME_TRAFFIC")
        self.assertEqual(p["adset"]["optimization_goal"], "LINK_CLICKS")
        self.assertEqual(p["adset"]["daily_budget"], 50000)
        t = p["adset"]["targeting"]
        self.assertEqual(t["geo_locations"], {"countries": ["IN"], "cities": [{"key": "1035921"}]})
        self.assertEqual(t["genders"], [2])
        self.assertEqual(t["flexible_spec"], [{"interests": [{"id": "6003", "name": "Gifts"}]}])
        link = p["creative"]["object_story_spec"]["link_data"]
        self.assertEqual(link["call_to_action"], {"type": "SHOP_NOW", "value": {"link": "https://example.in/diwali"}})
        self.assertEqual(link["picture"], "https://cdn.example.in/a.jpg")

    def test_special_category_removes_age_and_gender(self):
        t = meta_plan({**META, "specialAdCategories": ["CREDIT", "ISSUES_ELECTIONS_POLITICS"]})
        self.assertEqual(t["campaign"]["special_ad_categories"], ["CREDIT"])  # political never passes
        self.assertEqual((t["adset"]["targeting"]["age_min"], t["adset"]["targeting"]["age_max"]), (18, 65))
        self.assertNotIn("genders", t["adset"]["targeting"])

    def test_dates_use_workspace_offset(self):
        p = meta_plan({**META, "startDate": "2026-11-20", "timezoneOffset": "+0000"})
        self.assertEqual(p["adset"]["start_time"], "2026-11-20T00:00:00+0000")
        with self.assertRaises(ValueError):
            meta_plan({**META, "timezoneOffset": "IST"})

    def test_requires_page_and_image(self):
        for bad in ({**META, "pageId": None}, {**META, "imageUrl": "http://x"}, {**META, "objective": "sales"}):
            with self.assertRaises(ValueError):
                meta_plan(bad)

    def test_tag(self):
        self.assertTrue(tag_name("x" * 300, "abcdef0123").endswith("[arc:abcdef01]"))


if __name__ == "__main__":
    unittest.main()
