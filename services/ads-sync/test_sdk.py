"""Builds real SDK request objects offline (no network, dummy credentials) to prove field names and
enums match google-ads 35.1.0 / v26 and facebook-business 26.0.4. Runs in the Docker build."""
import unittest

from build import google_plan, meta_plan
from test_build import GOOGLE, META


class GoogleOps(unittest.TestCase):
    def test_atomic_operations(self):
        from google.ads.googleads.client import GoogleAdsClient
        from google.auth.credentials import AnonymousCredentials

        from manage import google_operations

        # constructed directly: load_from_dict would refresh OAuth over the network
        client = GoogleAdsClient(credentials=AnonymousCredentials(), developer_token="x", version="v26", use_proto_plus=True)
        ops = google_operations(client, "1234567890", google_plan(GOOGLE))
        kinds = [type(o).pb(o).WhichOneof("operation") for o in ops]
        self.assertEqual(kinds[:2], ["campaign_budget_operation", "campaign_operation"])
        self.assertEqual(kinds.count("ad_group_criterion_operation"), 2)
        self.assertEqual(kinds.count("campaign_criterion_operation"), 3)  # 1 location, 1 language, 1 negative
        c = ops[1].campaign_operation.create
        self.assertEqual(c.status.name, "PAUSED")
        self.assertFalse(c.network_settings.target_content_network)
        self.assertEqual(c.campaign_budget, "customers/1234567890/campaignBudgets/-1")
        self.assertEqual(c.contains_eu_political_advertising.name, "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING")
        ad = ops[-3].ad_group_ad_operation.create.ad
        self.assertEqual([h.text for h in ad.responsive_search_ad.headlines], ["One", "Two", "Three"])
        self.assertEqual(ad.responsive_search_ad.path1, "diwali")
        self.assertEqual(ops[0].campaign_budget_operation.create.amount_micros, 500_000_000)


class MetaParams(unittest.TestCase):
    def test_enum_values_exist(self):
        from facebook_business.adobjects.adcreativelinkdatacalltoaction import AdCreativeLinkDataCallToAction as CTA
        from facebook_business.adobjects.adset import AdSet
        from facebook_business.adobjects.campaign import Campaign

        p = meta_plan(META)
        self.assertIn(p["campaign"]["objective"], Campaign.Objective.__dict__.values())
        self.assertIn(p["adset"]["optimization_goal"], AdSet.OptimizationGoal.__dict__.values())
        self.assertIn(p["adset"]["billing_event"], AdSet.BillingEvent.__dict__.values())
        self.assertIn(p["adset"]["bid_strategy"], AdSet.BidStrategy.__dict__.values())
        self.assertIn(p["creative"]["object_story_spec"]["link_data"]["call_to_action"]["type"], CTA.Type.__dict__.values())
        for k in ("name", "objective", "status", "special_ad_categories", "is_adset_budget_sharing_enabled"):
            self.assertIn(k, Campaign.Field.__dict__.values())
        for k in p["adset"]:
            self.assertIn(k, AdSet.Field.__dict__.values())


if __name__ == "__main__":
    unittest.main()
