from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional
from dotenv import load_dotenv

import httpx
import os

load_dotenv()

DISCORD_CLIENT_SECRET = os.environ["DISCORD_CLIENT_SECRET"]
DISCORD_CLIENT_ID = os.environ["DISCORD_CLIENT_ID"]

app = FastAPI()

class Coords(BaseModel):
    latitude: float
    longitude: float


# Location.LocationObjectv
class Location(BaseModel):
    coords: Coords
    timestamp: float
    mocked: Optional[bool] = None


class User(BaseModel):
    name: str
    location: Location



users = []


@app.post("/update")
def update(user: User):
    for u in users:
        if u.name == user.name:
            u.location = user.location
            print("Updated user:", user.name)
            return {"status": "ok"}

    print("New user:", user.name)
    users.append(user)

    return {"status": "ok"}



class GetTokenRequest(BaseModel):
    code: str
    code_verifier: str


@app.post("/get_discord_token")
def get_discord_token(request: GetTokenRequest):
    # given code from oauth2
    resp = httpx.post("https://discord.com/api/oauth2/token", data={
        "client_id": DISCORD_CLIENT_ID,
        "client_secret": DISCORD_CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": request.code,
        "redirect_uri": "com.ulirocks.locshare://redirect",
        "scope": "identify guilds",
        "code_verifier": request.code_verifier,
    })
    body = resp.json()
    return body


@app.get("/users")
def get_users():
    return users
