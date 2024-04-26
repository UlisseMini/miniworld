from fastapi import FastAPI, Depends, Header, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, NewType
from dotenv import load_dotenv

import httpx
import secrets
import time
import os
import json

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
    avatar_url: str
    location: Optional[Location]


class DiscordAuth(BaseModel):
    access_token: str
    expires_in: int
    refresh_token: str
    scope: str
    token_type: str
    created_at: int


Session = NewType("Session", str)
class DB(BaseModel):
    sessions: Dict[Session, DiscordAuth] = {}
    user_info: Dict[Session, User] = {}

    def save(self):
        with open("db.json", "w") as f:
            json.dump(self.model_dump(), f)

    def load(self):
        try:
            with open("db.json", "r") as f:
                data = json.load(f)
                self.sessions = {Session(k): DiscordAuth(**v) for k, v in data["sessions"].items()}
                self.user_info = {Session(k): User(**v) for k, v in data["user_info"].items()}
        except FileNotFoundError:
            pass


db = DB()
db.load()

print(f"Loaded {len(db.sessions)} sessions and {len(db.user_info)} users from disk.")

# get session from Authorization header
def get_session(authorization: str = Header(None)) -> Session:
    if authorization is None:
        print("Authorization header is missing")
        raise HTTPException(status_code=401, detail="Authorization header is missing")
    try:
        # Assuming session token is passed directly as Authorization header
        session_key = Session(authorization)
        if session_key in db.sessions:
            # TODO: Use refresh token if expired
            auth = db.sessions[session_key]
            time_till_expiry = auth.created_at + auth.expires_in - int(time.time())
            if time_till_expiry < 0:
                # TODO: Maybe this doesn't matter? If the user's authenticated (in past) it's ok?
                # need to check guilds...
                print("Session expired")
                raise HTTPException(status_code=401, detail="Session expired")
            if session_key not in db.user_info:
                # should be populated in login endpoint.
                print("User not found for session")
                raise HTTPException(status_code=401, detail="User not found for session")

            return session_key
        else:
            print("Session not in db.sessions")
            raise HTTPException(status_code=401, detail="Invalid session")
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Invalid session format: {e}")


def get_user(session: Session = Depends(get_session)) -> User:
    if session in db.user_info:
        return db.user_info[session]
    else:
        raise HTTPException(status_code=404, detail="User not found")


@app.post("/update")
def update(location: Location, session: Session = Depends(get_session)):
    db.user_info[session].location = location
    db.save()

    return {"status": "ok"}


@app.get("/users")
def get_users(session: Session = Depends(get_session)):
    "Return all users in a list, always return the current user first"
    # TODO: Return in order of distance from current user <3
    user = db.user_info[session]
    return [user] + [v for k, v in db.user_info.items() if k != session]



class LoginRequest(BaseModel):
    code: str
    code_verifier: str


@app.post("/login/discord")
def login(request: LoginRequest):
    # given code from oauth2, get the access token
    resp = httpx.post("https://discord.com/api/oauth2/token", data={
        "client_id": DISCORD_CLIENT_ID,
        "client_secret": DISCORD_CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": request.code,
        "redirect_uri": "com.ulirocks.locshare://redirect",
        "scope": "identify guilds",
        "code_verifier": request.code_verifier,
    })
    if resp.status_code != 200:
        print(resp.text)
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"Discord oauth2/token error"
        )

    body = resp.json()
    auth = DiscordAuth(**body, created_at=int(time.time()))

    # get user info
    resp = httpx.get("https://discord.com/api/users/@me", headers={
        "Authorization": f"{auth.token_type} {auth.access_token}"
    })
    if resp.status_code != 200:
        print(resp.text)
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"Discord users/@me error"
        )

    user_info = resp.json()
    user = User(
        name=user_info["username"],
        avatar_url=f"https://cdn.discordapp.com/avatars/{user_info['id']}/{user_info['avatar']}.png",
        location=None
    )
    print(user)

    # Get guilds the user is in
    resp = httpx.get("https://discord.com/api/users/@me/guilds", headers={
        "Authorization": f"{auth.token_type} {auth.access_token}",
    })
    if resp.status_code != 200:
        print(resp.text)
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"Discord users/@me/guilds error"
        )
    guilds = resp.json()
    print(guilds)

    # Create a new session token and store everything
    session = Session(secrets.token_urlsafe(16))

    db.sessions[session] = auth
    db.user_info[session] = user
    db.save()

    return {"status": "ok", "session": str(session)}

