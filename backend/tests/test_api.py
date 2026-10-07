"""API tests. Run from the backend folder:  python -m unittest discover -s tests -v"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app import create_app  # noqa: E402


class ApiTests(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.client = create_app(self.path).test_client()

    def tearDown(self):
        os.remove(self.path)

    # helpers
    def register(self, name="Test Student", phone="9876543210", password="anbu123"):
        return self.client.post("/api/register", json={"name": name, "phone": phone, "password": password})

    def login(self, phone="9876543210", password="anbu123"):
        return self.client.post("/api/login", json={"phone": phone, "password": password})

    def auth(self, phone="9876543210", password="anbu123"):
        token = self.login(phone, password).get_json()["token"]
        return {"Authorization": "Bearer " + token}

    # tests
    def test_health(self):
        self.assertTrue(self.client.get("/api/health").get_json()["ok"])

    def test_register_and_login(self):
        self.assertEqual(self.register().status_code, 201)
        r = self.login()
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertEqual(data["user"], {"name": "Test Student", "phone": "9876543210", "role": "user"})
        self.assertTrue(data["token"])

    def test_register_validation(self):
        self.assertEqual(self.register(name="A").status_code, 400)
        self.assertEqual(self.register(phone="12345").status_code, 400)
        self.assertEqual(self.register(password="abc").status_code, 400)

    def test_duplicate_phone(self):
        self.register()
        self.assertEqual(self.register().status_code, 409)

    def test_wrong_password_and_unknown_user(self):
        self.register()
        self.assertEqual(self.login(password="wrong").status_code, 401)
        self.assertEqual(self.login(phone="9999999999").status_code, 401)

    def test_password_is_hashed(self):
        import sqlite3
        self.register()
        stored = sqlite3.connect(self.path).execute("SELECT password_hash FROM users").fetchone()[0]
        self.assertNotIn("anbu123", stored)

    def test_contacts_roundtrip(self):
        self.register()
        h = self.auth()
        self.assertEqual(self.client.get("/api/contacts", headers=h).get_json()["contacts"], ["", "", ""])
        r = self.client.put("/api/contacts", headers=h, json={"contacts": ["9111111111", "", "9333333333"]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.client.get("/api/contacts", headers=h).get_json()["contacts"],
                         ["9111111111", "", "9333333333"])

    def test_contacts_validation(self):
        self.register()
        h = self.auth()
        self.assertEqual(self.client.put("/api/contacts", headers=h, json={"contacts": ["123"]}).status_code, 400)
        self.assertEqual(self.client.put("/api/contacts", headers=h, json={"contacts": "x"}).status_code, 400)

    def test_requires_token(self):
        self.assertEqual(self.client.get("/api/contacts").status_code, 401)
        self.assertEqual(self.client.post("/api/sos", json={}).status_code, 401)
        self.assertEqual(self.client.get("/api/users").status_code, 401)

    def test_admin_login_and_lists(self):
        self.register()
        user_h = self.auth()
        self.client.post("/api/sos", headers=user_h, json={"lat": 13.0827, "lng": 80.2707, "trigger": "shake"})
        r = self.login(phone="admin", password="admin123")
        self.assertEqual(r.get_json()["user"]["role"], "admin")
        admin_h = {"Authorization": "Bearer " + r.get_json()["token"]}
        users = self.client.get("/api/users", headers=admin_h).get_json()["users"]
        self.assertEqual([u["phone"] for u in users], ["9876543210"])
        self.assertNotIn("password_hash", users[0])
        alerts = self.client.get("/api/sos", headers=admin_h).get_json()["alerts"]
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]["trigger"], "shake")
        self.assertEqual(alerts[0]["link"], "https://maps.google.com/?q=13.082700,80.270700")

    def test_admin_wrong_password(self):
        self.assertEqual(self.login(phone="admin", password="nope").status_code, 401)

    def test_normal_user_cannot_see_admin_data(self):
        self.register()
        h = self.auth()
        self.assertEqual(self.client.get("/api/users", headers=h).status_code, 403)
        self.assertEqual(self.client.get("/api/sos", headers=h).status_code, 403)

    def test_sos_without_location(self):
        self.register()
        h = self.auth()
        self.assertEqual(self.client.post("/api/sos", headers=h, json={"trigger": "button"}).status_code, 201)
        admin_h = {"Authorization": "Bearer " + self.login("admin", "admin123").get_json()["token"]}
        a = self.client.get("/api/sos", headers=admin_h).get_json()["alerts"][0]
        self.assertIsNone(a["lat"])
        self.assertEqual(a["link"], "")

    def test_sos_rejects_fake_link_and_bad_coordinates(self):
        self.register()
        h = self.auth()
        self.client.post("/api/sos", headers=h, json={"lat": 999, "lng": "abc", "link": "http://evil.example", "trigger": "x"})
        admin_h = {"Authorization": "Bearer " + self.login("admin", "admin123").get_json()["token"]}
        a = self.client.get("/api/sos", headers=admin_h).get_json()["alerts"][0]
        self.assertIsNone(a["lat"])
        self.assertIsNone(a["lng"])
        self.assertEqual(a["link"], "")
        self.assertEqual(a["trigger"], "button")

    def test_bad_token(self):
        r = self.client.get("/api/contacts", headers={"Authorization": "Bearer nonsense"})
        self.assertEqual(r.status_code, 401)

    def test_frontend_is_served(self):
        r = self.client.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertIn(b"Women Safety System", r.data)
        self.assertEqual(self.client.get("/js/app.js").status_code, 200)
        self.assertEqual(self.client.get("/css/style.css").status_code, 200)


if __name__ == "__main__":
    unittest.main()
