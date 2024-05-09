from fastapi import FastAPI, Depends, Header, HTTPException
from fastapi.responses import HTMLResponse
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
import html

load_dotenv()

DISCORD_CLIENT_SECRET = os.environ["DISCORD_CLIENT_SECRET"]
DISCORD_CLIENT_ID = os.environ["DISCORD_CLIENT_ID"]
EMAIL = 'uli@miniworld.app'

# Servers we support in beta
DEMO_GUILD_ID = "0000000000000000000"
DEMO_GUILD = {"id": DEMO_GUILD_ID, "name": "Demo Guild", "icon": None}

SUPPORTED_SERVERS = set([
    # '1147040380672544808', # lost ones
    '1014436790251290624', # agents of change
    '982436897571881061', # atlas fellows
    DEMO_GUILD_ID, # demo guild id
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


class LocatedUser(BaseModel):
    "Sent to the frontend, contains everything necessary to display a user."
    name: str
    avatar_url: str
    location: Location
    # Guilds in common with the current user
    common_guilds: List[GuildInfo] = []


class DiscordUser(BaseModel):
    id: UserID
    username: str
    avatar_url: Optional[str]
    guilds: List[GuildInfo]


class UserData(BaseModel):
    "All the data we store for each user"
    duser: DiscordUser # info we got from discord
    location: Optional[Location] # location once set
    settings: Settings
    auth: DiscordAuth
    pushToken: Optional[str] = None

    @property
    def id(self) -> UserID:
        return UserID(self.duser.id)

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



def create_demo_user(name: str, id: str) -> UserData:
    random.seed("demo" + id)
    dlat = random.uniform(-0.05, 0.05)
    dlon = random.uniform(-0.05, 0.05)

    return UserData(
        duser=DiscordUser(
            id=UserID(id),
            username=name,
            avatar_url=f"https://cdn.discordapp.com/embed/avatars/{id}.png",
            guilds=[GuildInfo(**DEMO_GUILD)],
        ),
        location=Location(
            coords=Coords(
                latitude=37.33182 + dlat,
                longitude=-122.03118 + dlon,
            ),
            timestamp=0,
        ),
        settings=Settings(
            guild_ids=[DEMO_GUILD_ID],
            privacy_margin={},
        ),
        auth=DiscordAuth(
            access_token="demo",
            expires_in=int(1e20), # never
            refresh_token="demo",
            scope="demo",
            token_type="demo",
            created_at=int(time.time()),
        ),
    )



def setup_demo_user(db: DB):
    # add demo stuff (for apple testers)
    db.users[UserID("1")] = create_demo_user(name="Demo User", id="1")
    db.users[UserID("2")] = create_demo_user(name="Demo User 2", id="2")

    session, userid = Session("demo"), UserID("1")
    db.user_id[session] = userid # only userid=1 needs to be logged in to


db = DB.load()
setup_demo_user(db)


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
            print(f"Session {session} not in db.user_id")
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
    db.users[id].location = location
    db.save()

    return {"status": "ok"}


@app.get("/users")
def get_users(user: UserData = Depends(get_user)) -> List[LocatedUser]:
    "Return all users, with closest first ([0] is always the current user)"

    # return the users with guilds in common. make sure to use
    # settings.guilds because we only want to use guilds that are in SUPPORTED_SERVERS,
    # and settings.guilds is automatically filtered like that. this is a bit scuffed.
    located_users = [
        LocatedUser(
            name=u.duser.username,
            # TODO (low priority) get the actual default-avatar they have.
            avatar_url=u.duser.avatar_url or "https://cdn.discordapp.com/embed/avatars/0.png",
            location=u.location,
            common_guilds=[g for g in u.duser.guilds if g.id in user.settings.guild_ids],
        )
        for u in db.users.values()
        if u.location is not None
    ]

    # filter out people with no common guilds
    located_users = [u for u in located_users if u.common_guilds]

    # make ourselves the first user returned, if we're located
    if user.location is not None:
        coords = user.location.coords
        located_users = sorted(
            located_users,
            key=lambda u: geodesic(
                (coords.latitude, coords.longitude),
                (u.location.coords.latitude, u.location.coords.longitude)
            ).kilometers
        )

    return located_users


class LoginRequest(BaseModel):
    code: str
    code_verifier: str
    location: Optional[Location] = None
    pushToken: Optional[str] = None


@app.post("/login/discord")
def login(request: LoginRequest):
    # given code from oauth2, get the access token
    resp = httpx.post("https://discord.com/api/oauth2/token", data={
        "client_id": DISCORD_CLIENT_ID,
        "client_secret": DISCORD_CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": request.code,
        "redirect_uri": "com.ulirocks.miniworld://redirect",
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

    # Create discord user
    duser = DiscordUser(
        id=UserID(user_info["id"]),
        username=user_info["username"],
        avatar_url=f"https://cdn.discordapp.com/avatars/{user_info['id']}/{user_info['avatar']}.png",
        guilds=[GuildInfo(**g) for g in guilds],
    )

    # Create a new session token and store everything
    session = Session(secrets.token_urlsafe(16))
    db.user_id[session] = duser.id

    # TODO: once /settings page is used by frontend we must get rid of these defaults
    # and use [] and {} instead.

    supported_guild_ids = [gid for gid in SUPPORTED_SERVERS if gid in [g["id"] for g in guilds]]
    settings = Settings(guild_ids=supported_guild_ids)

    # Store the rest of the user data, like their discord tokens, guilds, etc.
    user = UserData(
        duser=duser,
        location=request.location,
        auth=auth,
        settings=settings,
        pushToken=request.pushToken,
    )
    db.users[user.id] = user
    db.save()

    # pass users too so frontend doesn't have to make another request.
    return {"status": "ok", "session": str(session), "users": get_users(user), "guilds": guilds}



@app.get("/login/discord")
def login_discord_html():
    return HTMLResponse("""
        <h1>Login</h1>
    """)


@app.post("/settings")
def settings(request: Settings, user: UserData = Depends(get_user)):
    if not set(request.guild_ids).issubset(SUPPORTED_SERVERS):
        raise HTTPException(status_code=400, detail=f"At least one guild id is not supported yet")

    our_guilds = set(g.id for g in user.duser.guilds)
    if not set(request.guild_ids).issubset(our_guilds):
        raise HTTPException(status_code=400, detail=f"At least one guild id not in user's guilds")

    if any(v < 0 or v > 10000 for v in request.privacy_margin.values()):
        raise HTTPException(status_code=400, detail=f"Invalid privacy margin. not in [0, 10000]")

    # good settings! keep them
    db.users[user.id].settings = request
    db.save()

    return {"status": "ok"}


PRE_STYLES = "white-space: pre-wrap; max-width: 70ch; line-height: 1.3;"


@app.get("/delete_data")
def delete_data(
    # user: UserData = Depends(get_user),
    # session: Session = Depends(get_session)
):
    return HTMLResponse(f'<pre style="{PRE_STYLES}">To request data deletion email us <a href="mailto:{EMAIL}">here</a>.</pre>')

    # del db.users[user.id]
    # del db.user_id[session]
    # db.save()
    # return HTMLResponse('<h1 style="font-family: monospace">All user data deleted. You may close this tab.</h1>')



PRIVACY_POLICY = open("privacy-policy.txt", "r").read()

@app.get("/privacy-policy")
async def privacy_policy():
    return HTMLResponse(
        content=f'<pre style="{PRE_STYLES}">' + html.escape(PRIVACY_POLICY) + '</pre>'
    )


@app.get("/support")
async def support():
    return HTMLResponse(
        content=f'<pre style="{PRE_STYLES}">For support contact us at <a href="mailto:{EMAIL}">{EMAIL}</a></pre>'
    )
