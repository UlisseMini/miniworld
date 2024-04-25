from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional

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



@app.get("/users")
def get_users():
    return users
