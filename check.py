import json
from pymongo import MongoClient
from bson import ObjectId


# =========================
# MongoDB Configuration
# =========================

MONGO_URI = "mongodb+srv://dhruvvayugundla:DDD123ddd@cluster1.j4w98fr.mongodb.net/"
DATABASE_NAME = "papaweb"


# =========================
# Load names.json
# =========================

with open("names.json", "r", encoding="utf-8") as file:
    names = json.load(file)


# =========================
# Connect to MongoDB
# =========================

client = MongoClient(MONGO_URI)
db = client[DATABASE_NAME]

remedies_te = db["remedies-te"]
remedies_en = db["remedies-en"]
remedies_hi = db["remedies-hi"]


# =========================
# Update collections
# =========================

count = 0

for item in names:

    # Supports:
    # "_id": {"$oid": "..."}
    # and:
    # "_id": "..."

    if isinstance(item["_id"], dict):
        oid = item["_id"]["$oid"]
    else:
        oid = item["_id"]

    object_id = ObjectId(oid)

    name_te = item.get("name-te")
    name_en = item.get("name-en")
    name_hi = item.get("name-hi")

    # -------------------------
    # remedies-te
    # -------------------------

    te_result = remedies_te.update_one(
        {"_id": object_id},
        {
            "$set": {
                "name": name_te,
                "name-en": name_en,
                "name-hi": name_hi
            }
        }
    )

    # -------------------------
    # remedies-en
    # -------------------------

    en_result = remedies_en.update_one(
        {"_id": object_id},
        {
            "$set": {
                "name": name_en,
                "name-te": name_te,
                "name-hi": name_hi
            }
        }
    )

    # -------------------------
    # remedies-hi
    # -------------------------

    hi_result = remedies_hi.update_one(
        {"_id": object_id},
        {
            "$set": {
                "name": name_hi,
                "name-te": name_te,
                "name-en": name_en
            }
        }
    )

    count += 1

    print(
        f"{oid} | "
        f"TE: {te_result.matched_count} | "
        f"EN: {en_result.matched_count} | "
        f"HI: {hi_result.matched_count}"
    )


# =========================
# Done
# =========================

print(f"\nFinished updating {count} entries.")

client.close()