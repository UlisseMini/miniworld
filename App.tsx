import { useState, useEffect, useCallback } from "react";
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
      console.log("update error:", error, "more:", error.response.data)
    );
};

TaskManager.defineTask(LOCATION_TASK_NAME, ({ data, error }) => {
  if (error) {
    console.error(`${LOCATION_TASK_NAME}:`, error);
    return;
  }

  const locations = (data as any).locations;
  if (locations) {
    updateServer(locations);
  }
});

type User = {
  name: string;
  avatar_url: string;
  location: Location.LocationObject;
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
  setState: (state: GlobalState) => void;
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

      // Check if we have location permissions
      const hasPermissions = await hasLocationPermissions();

      console.log(
        `valid session?: ${validSession} location perms?: ${hasPermissions}`
      );

      // Update state based on what we've learned
      const state = { session: session, hasPermissions, users };
      if (validSession && hasPermissions) {
        await ensureLocationUpdatesStarted();
        setState({ ...state, page: "map" });
      } else if (validSession && !hasPermissions) {
        setState({ ...state, page: "request_location" });
      } else {
        setState({ ...state, page: "login" });
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
          console.log("login response", response.data);
          const session = response.data.session;
          const users = response.data.users;
          const page = state.hasPermissions ? "map" : "request_location";
          setState({ page, session, users });
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
        promptAsync({ showInRecents: true });
      }}
    />
  );
}

// TODO: This should be a Modal that floats above the map
function RequestLocationPage(props: GlobalProps) {
  const { state, setState } = props;

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
                setState({ ...state, page: "map", hasPermissions: true });
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

  // Function to update users in state asynchronously,
  // and clear the session if we get a 401.
  const updateUsers = useCallback(async () => {
    try {
      const users = await getUsers(session);
      setState({ ...state, users });
    } catch (e) {
      if (e.response.status === 401) {
        console.log("session expired; logging out");
        setState({ ...state, session: "", page: "login" });
      } else {
        console.error("error updating users:", e);
      }
    }
  }, []);

  // Update stored users periodically. A websocket would be more data-efficient.
  useEffect(() => {
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
      {users
        // TODO: Get rid of filter; shouldn't have to validate every time.
        ?.filter(
          (u) =>
            !!u.location &&
            !!u.location.coords &&
            typeof u.location.coords.latitude === "number" &&
            typeof u.location.coords.longitude === "number"
        )
        .map((user, index) => (
          <Marker
            key={index}
            coordinate={user.location.coords}
            title={`name: ${user.name}`}
          >
            <Image source={user.avatar_url} style={styles.avatar} />
          </Marker>
        ))}
    </MapView>
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
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    opacity: 0.7,
  },
});
