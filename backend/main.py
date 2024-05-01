from fastapi import FastAPI, Depends, Header, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, NewType, List
from dotenv import load_dotenv
from traceback import print_exc
from geopy.distance import geodesic

import httpx
import secrets
import time
import os
import json
import random

load_dotenv()

DISCORD_CLIENT_SECRET = os.environ["DISCORD_CLIENT_SECRET"]
DISCORD_CLIENT_ID = os.environ["DISCORD_CLIENT_ID"]

# Servers we support in beta
SUPPORTED_SERVERS = set([
    # '1147040380672544808', # lost ones
    '1014436790251290624', # agents of change
    '982436897571881061', # atlas fellows
])


app = FastAPI()


Session = NewType("Session", str)
UserID = NewType("UserID", str)


class Coords(BaseModel):
    latitude: float
    longitude: float


# Location.LocationObjectv
class Location(BaseModel):
    coords: Coords
    timestamp: float
    mocked: Optional[bool] = None
    # accuracy in meters. TODO
    # accuracy: int = 0


class DiscordAuth(BaseModel):
    access_token: str
    expires_in: int
    refresh_token: str
    scope: str
    token_type: str
    created_at: int


class GuildInfo(BaseModel):
    "Guild info from /users/@me/guilds, we only use id, name, icon for now."
    id: str
    name: str
    icon: Optional[str]


class Settings(BaseModel):
    """
    User settings. Conceptually 1-1 to a settings screen on the app, except
    we validate the user is in the guilds they want to share their location with,
    and that the privacy margin is reasonable.
    """

    # guild_ids we want to share our location with
    guild_ids: List[str]
    # privacy margin in meters
    privacy_margin: Dict[str, int]


class LocatedUser(BaseModel):
    "Sent to the frontend, contains everything necessary to display a user."
    id: UserID
    name: str
    avatar_url: str
    location: Location
    # Guilds in common with the current user
    common_guilds: List[GuildInfo] = []


class UserData(BaseModel):
    "All the data we store for each user"
    user: LocatedUser
    guilds: List[GuildInfo]
    settings: Settings
    auth: DiscordAuth
    pushToken: Optional[str] = None

    @property
    def id(self):
        return self.user.id


class DB(BaseModel):
    """
    Database model, saved to disk as JSON. Will be converted to a real database later.
    """

    user_id: Dict[Session, UserID] = {}
    users: Dict[UserID, UserData] = {}

    def save(self):
        with open("db.json", "w") as f:
            json.dump(self.model_dump(), f)


    @classmethod
    def load(cls):
        try:
            with open("db.json", "r") as f:
                data = json.load(f)
                return cls(**data)

        except Exception:
            print_exc()
            print("Error loading db.json, starting with empty db.")
            x = cls()
            x.save()
            return x


db = DB.load()

print(f"Loaded {len(db.user_id)} sessions and {len(db.users)} users from disk.")

# get session from Authorization header
def get_session(authorization: str = Header(None)) -> Session:
    if authorization is None:
        print("Authorization header is missing")
        raise HTTPException(status_code=401, detail="Authorization header is missing")
    try:
        # Assuming session token is passed directly as Authorization header, for now
        # TODO: Should probably switch to Bearer token format, that's more standard.
        session = Session(authorization)
        user_id = db.user_id.get(session)
        if user_id:
            auth = db.users[user_id].auth
            time_till_expiry = auth.created_at + auth.expires_in - int(time.time())
            if time_till_expiry < 0:
                # TODO: Attempt to refresh using refresh token
                print("Session expired. clearing session.")
                del db.user_id[session]
                raise HTTPException(status_code=401, detail="Session expired")

            return session
        else:
            print("Session not in db.user_id")
            raise HTTPException(status_code=401, detail="Invalid session")
    except Exception as e:
        # re-raise HTTPException
        if isinstance(e, HTTPException):
            raise e

        print_exc()
        raise HTTPException(status_code=500, detail=f"Internal server error: {e}")



def get_user_id(session: Session = Depends(get_session)) -> UserID:
    return db.user_id[session]

def get_user(user_id = Depends(get_user_id)) -> UserData:
    return db.users[user_id]


@app.post("/update")
def update(location: Location, id: UserID = Depends(get_user_id)):
    db.users[id].user.location = location
    db.save()

    return {"status": "ok"}


@app.get("/users")
def get_users(user: UserData = Depends(get_user)) -> List[LocatedUser]:
    "Return all users, with closest first ([0] is always the current user)"

    # return the users with guilds in common. make sure to use
    # settings.guilds because we only want to use guilds that are in SUPPORTED_SERVERS,
    # and settings.guilds is automatically filtered like that. this is a bit scuffed.
    located_users = []

    for u in db.users.values():
        # guilds in common...
        common_guild_ids = set(u.settings.guild_ids).intersection(user.settings.guild_ids)
        if common_guild_ids:
            # add common guilds to each user object so the frontend can display things nicely
            common_guilds = [g for g in u.guilds if g.id in common_guild_ids]
            loc_user = u.user.copy(update=dict(common_guilds=common_guilds), deep=True)

            # randomize distance in a deterministic way according to privacy margin
            # TODO: Remove privacy margin from everywhere. Rounding lat/lon is simpler.
            # privacy_margin = max(u.settings.privacy_margin[gid] for gid in common_guild_ids)

            loc_user.location.coords.latitude = round(loc_user.location.coords.latitude, 2)
            loc_user.location.coords.longitude = round(loc_user.location.coords.longitude, 2)

            # finally save them :)
            located_users.append(loc_user)



    # then sort by distance
    located_users.sort(
        key=lambda u: geodesic(
            (user.user.location.coords.latitude, user.user.location.coords.longitude),
            (u.location.coords.latitude, u.location.coords.longitude)
        ).kilometers
    )
    print(located_users)


    return located_users


class LoginRequest(BaseModel):
    code: str
    code_verifier: str
    location: Location
    pushToken: Optional[str] = None


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
    user = LocatedUser(
        id=user_info["id"],
        name=user_info["username"],
        avatar_url=f"https://cdn.discordapp.com/avatars/{user_info['id']}/{user_info['avatar']}.png",
        location=request.location,
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

    # Create a new session token and store everything
    session = Session(secrets.token_urlsafe(16))
    db.user_id[session] = user.id

    # TODO: once /settings page is used by frontend we must get rid of these defaults
    # and use [] and {} instead.

    supported_guild_ids = [gid for gid in SUPPORTED_SERVERS if gid in [g["id"] for g in guilds]]
    settings = Settings(
        guild_ids=supported_guild_ids,
        privacy_margin={gid: 1000 for gid in supported_guild_ids}, # 1km
    )

    # Store the rest of the user data, like their discord tokens, guilds, etc.
    user = UserData(
        user=user,
        guilds=[GuildInfo(**g) for g in guilds],
        auth=auth,
        settings=settings,
        pushToken=request.pushToken,
    )
    db.users[user.id] = user
    db.save()

    # pass users too so frontend doesn't have to make another request.
    return {"status": "ok", "session": str(session), "users": get_users(user), "guilds": guilds}



@app.post("/settings")
def settings(request: Settings, user: UserData = Depends(get_user)):
    if not set(request.guild_ids).issubset(SUPPORTED_SERVERS):
        raise HTTPException(status_code=400, detail=f"At least one guild id is not supported yet")

    our_guilds = set(g.id for g in user.guilds)
    if not set(request.guild_ids).issubset(our_guilds):
        raise HTTPException(status_code=400, detail=f"At least one guild id not in user's guilds")

    if any(v < 0 or v > 10000 for v in request.privacy_margin.values()):
        raise HTTPException(status_code=400, detail=f"Invalid privacy margin. not in [0, 10000]")

    # good settings! keep them
    db.users[user.id].settings = request
    db.save()

    return {"status": "ok"}

