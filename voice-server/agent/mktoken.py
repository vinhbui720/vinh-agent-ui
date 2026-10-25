"""Print a LiveKit join token: python token.py [room] [identity]. Reads LIVEKIT_API_KEY/SECRET from env."""
import os, sys
from livekit import api
room, who = (sys.argv + ["voice", "vinh"])[1:3]
print(api.AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"]).with_identity(who)
      .with_grants(api.VideoGrants(room_join=True, room=room)).with_ttl(__import__("datetime").timedelta(hours=12)).to_jwt())
