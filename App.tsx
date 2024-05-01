import { useState, useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";
import { StyleSheet, Button, Text, View } from "react-native";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import axios from "axios";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as AuthSession from "expo-auth-session";
import { Image } from "expo-image";

// WebBrowser.maybeCompleteAuthSession(); // web only; on mobile does nothing

const LOCATION_TASK_NAME = "background-location-task";
const HOST = "https://loc.uli.rocks";

const requestLocationPermissions = async () => {
  const { status: foregroundStatus } =
    await Location.requestForegroundPermissionsAsync();
  if (foregroundStatus === "granted") {
    const { status: backgroundStatus } =
      await Location.requestBackgroundPermissionsAsync();
    if (backgroundStatus === "granted") {
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: Location.Accuracy.Lowest, // PRIVACY. TODO: BETTER SOLUTION
      });
      return true;
    }
    console.warn("background location permissions not granted");
    return false;
  }
  console.warn("foreground location permissions not granted");
  return false;
};

const updateServer = async (locations: Location.LocationObject[]) => {
  const location = locations[0];
  console.log("Received new location", location);

  // update the server
  const session = await AsyncStorage.getItem("session");
  console.log("Using session", session);
  if (!session) {
    console.log("No session found. Cannot update server!");
    return;
  }

  axios
    .post(`${HOST}/update`, location, {
      headers: {
        Authorization: `${session}`,
      },
    })
    .then((response) => console.log("updated server:", response.status))
    .catch((error) =>
      console.error("update error:", error, "more:", error.response.data)
    );
};

TaskManager.defineTask(LOCATION_TASK_NAME, ({ data, error }) => {
  if (error) {
    console.error(`${LOCATION_TASK_NAME}:`, error);
    return;
  }

  const locations = (data as any).locations;
  if (locations) {
    console.log("BACKGROUND LOCATIONS UPDATE");
    updateServer(locations);
  }
});

type Guild = {
  name: string;
  icon: string | null; // url
};

type User = {
  name: string;
  avatar_url: string;
  location: Location.LocationObject;
  common_guilds: Guild[];
};

const discovery = {
  authorizationEndpoint: "https://discord.com/api/oauth2/authorize",
  tokenEndpoint: "https://discord.com/api/oauth2/token",
  revocationEndpoint: "https://discord.com/api/oauth2/token/revoke",
};

const getUsers = async (session: string) => {
  if (!session) throw new Error("no session");
  const response = await axios.get(`${HOST}/users`, {
    headers: { Authorization: `${session}` },
  });

  return response.data;
};

const hasLocationPermissions = async () => {
  const [p1, p2] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
  ]);
  return p1.status === "granted" && p2.status === "granted";
};

const ensureLocationUpdatesStarted = async () => {
  const started = await Location.hasStartedLocationUpdatesAsync(
    LOCATION_TASK_NAME
  );

  if (!started) {
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.Lowest,
    });
  }
};

type Page = "loading" | "login" | "request_location" | "map";

type GlobalState = {
  session: string;
  page: Page;
  hasPermissions?: boolean;
  users?: User[];
};

type GlobalProps = {
  state: GlobalState;
  setState: (update: (prevState: GlobalState) => GlobalState) => void;
};

export default function Index() {
  // Context probably makes more sense here, whatever
  const [state, setState] = useState<GlobalState>({
    page: "loading",
    session: "",
  });

  // load the correct page
  const props = { state, setState: setState };
  const pageComponent = {
    loading: () => <LoadingPage {...props} />,
    login: () => <LoginPage {...props} />,
    request_location: () => <RequestLocationPage {...props} />,
    map: () => <MapPage {...props} />,
  }[state.page]();

  // render the page
  return (
    <View style={styles.container}>
      {pageComponent}
      <StatusBar style="auto" />
    </View>
  );
}

function LoadingPage(props: GlobalProps) {
  const { setState } = props;

  // On start, check the status of our session and location permissions,
  // use that to determine which page to show.
  useEffect(() => {
    (async () => {
      // Check if session is valid
      const session = await AsyncStorage.getItem("session");
      const users = await getUsers(session).catch(() => null);
      const validSession = !!users;

      // Don't store bad sessions
      if (!validSession) await AsyncStorage.removeItem("session");

      // Check if we have location permissions
      const hasPermissions = await hasLocationPermissions();

      console.log(
        `valid session?: ${validSession} location perms?: ${hasPermissions}`
      );

      // Update state based on what we've learned
      const diff = { session: session, hasPermissions, users };
      if (validSession && hasPermissions) {
        await ensureLocationUpdatesStarted();
        setState((state) => ({ ...state, ...diff, page: "map" }));
      } else if (validSession && !hasPermissions) {
        setState((state) => ({ ...state, ...diff, page: "request_location" }));
      } else {
        setState((state) => ({ ...state, ...diff, page: "login" }));
      }
    })(); // TODO: catch async exceptions & show an error page
  }, []);

  return <Text>Loading...</Text>;
}

function LoginPage(props: GlobalProps) {
  const { state, setState } = props;
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: "1232840493696680038",
      redirectUri: AuthSession.makeRedirectUri({
        scheme: "com.ulirocks.locshare",
        path: "redirect",
      }),
      usePKCE: true,
      scopes: ["identify", "guilds"],
    },
    discovery
  );

  // Exchange discord oauth code for (backend-made) session once we have it
  useEffect(() => {
    if (response?.type === "success") {
      const { code } = response.params;

      // FIXME: We need to refactor so we get location perms **BEFORE LOGIN** (BIG REFACTOR)
      requestLocationPermissions()
        .then((granted) => {
          if (!granted) {
            throw new Error("Location permissions not granted");
          }

          return Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Lowest,
          });
        })
        .then((location) => {
          return axios.post(`${HOST}/login/discord`, {
            code: code,
            code_verifier: request.codeVerifier,
            location: location,
          });
        })
        .then((response) => {
          const session = response.data.session;
          const users = response.data.users;
          const page = state.hasPermissions ? "map" : "request_location";
          setState((state) => ({ ...state, page, session, users }));
          return AsyncStorage.setItem("session", session);
        })
        .then(() => console.log("session stored."))
        .catch((error) => console.error("login error", error));
    } else if (response?.type === "error") {
      console.error("login error", response.error);
    }
  }, [response]);

  return (
    <Button
      disabled={!request}
      title="Login with discord"
      onPress={() => {
        // showInRecents: true is required for 2fa on android
        console.log("prompting for login");

        // TODO: Handle promise, maybe change oauth flow to be async-based, as
        // hooks are weird. Also, this may caused unhandled promise rejection
        // earlier.
        promptAsync({ showInRecents: true });
      }}
    />
  );
}

// TODO: This should be a Modal that floats above the map
function RequestLocationPage(props: GlobalProps) {
  const { setState } = props;

  return (
    <>
      <Text style={{ fontSize: 20, margin: 50 }}>
        LocShare needs background location access so we can notify you when
        there's a potential meetup opportunity!!
      </Text>
      <Button
        title="Grant background location permissions"
        onPress={() => {
          requestLocationPermissions()
            .then((granted) => {
              if (granted) {
                const diff = { hasPermissions: true, page: "map" as Page };
                setState((state) => ({ ...state, ...diff }));
              } else {
                // TODO: Error for user
                console.error("location permissions not granted");
              }
            })
            .catch((error) => {
              console.error("granting location permissions", error);
            });
        }}
      />
    </>
  );
}

function MapPage(props: GlobalProps) {
  const { state, setState } = props;
  const { users, session } = state;

  // Update stored users periodically. A websocket would be more data-efficient.
  useEffect(() => {
    const updateUsers = async () => {
      try {
        const users = await getUsers(session);
        setState((state) => ({ ...state, users }));
      } catch (e) {
        if (e.response.status === 401) {
          console.log("session expired; logging out");
          setState((state) => ({ ...state, session: "", page: "login" }));
        } else {
          console.error("error updating users:", e);
        }
      }
    };

    const interval = setInterval(updateUsers, 3000);
    return () => clearInterval(interval);
  }, [session]);

  // Acquire our location (users[0] by backend convention) and set the map region
  // to center on it.
  const coords = users?.[0]?.location?.coords;
  const region = coords
    ? {
        latitude: coords.latitude,
        longitude: coords.longitude,
        latitudeDelta: 0.922,
        longitudeDelta: 0.421,
      }
    : null;

  return (
    <MapView
      style={styles.map}
      provider={PROVIDER_GOOGLE}
      initialRegion={region}
    >
      {users.map((user, index) => {
        // const latlon = user.location.coords;
        // console.log(`${user.name} at ${latlon.latitude}, ${latlon.longitude}`);

        return <UserMarker key={index} user={user} />;
      })}
    </MapView>
  );
}

// Custom marker required because of bug
// https://github.com/react-native-maps/react-native-maps/issues/3098#issuecomment-881287495
// supposedly fixed in https://github.com/react-native-maps/react-native-maps/pull/5020 but
// I upgraded and still had the problem where tracksViewChanges={false} prevented image load.
//
// Another solution would be to call redraw() on the marker after the image has loaded,
// but that would be less react-y. So I'm doing this.
function UserMarker(props: { user: User }) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const user = props.user;

  return (
    <Marker
      tracksViewChanges={!imageLoaded}
      coordinate={user.location.coords}
      title={`${user.name}`}
      description={`common servers: ${user.common_guilds
        .map((g) => g.name)
        .join(", ")}`}
    >
      {/* Use view because setting borderRadius directly on <Image> didn't work on Android. */}
      <View style={styles.avatarContainer}>
        <Image
          style={styles.avatar}
          source={user.avatar_url}
          onLoadEnd={() => setImageLoaded(true)}
        />
      </View>
    </Marker>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  map: {
    width: "100%",
    height: "100%",
  },
  avatarContainer: {
    width: 50,
    height: 50,
    borderRadius: 25,
    overflow: "hidden",
    opacity: 0.7,
  },
  avatar: {
    width: "100%",
    height: "100%",
  },
});
