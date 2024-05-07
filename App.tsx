import { useState, useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";
import {
  StyleSheet,
  Button,
  Pressable,
  Text,
  View,
  Platform,
  AppState,
} from "react-native";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import axios from "axios";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as AuthSession from "expo-auth-session";
import { Image } from "expo-image";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import * as Device from "expo-device";

const LOCATION_TASK_NAME = "background-location-task";
const HOST = "https://loc.uli.rocks";

console.debug = () => {}; // disable debug logs

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

// Copied from https://docs.expo.dev/push-notifications/push-notifications-setup
async function registerForPushNotificationsAsync(): Promise<String | null> {
  if (Platform.OS === "android") {
    Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#FF231F7C",
    });
  }

  if (Device.isDevice) {
    const { status: existingStatus } =
      await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== "granted") {
      handleRegistrationError(
        "Permission not granted to get push token for push notification!"
      );
      return;
    }
    const projectId =
      Constants?.expoConfig?.extra?.eas?.projectId ??
      Constants?.easConfig?.projectId;
    if (!projectId) {
      handleRegistrationError("Project ID not found");
    }
    try {
      const pushTokenString = (
        await Notifications.getExpoPushTokenAsync({
          projectId,
        })
      )?.data;
      console.log(pushTokenString);
      return pushTokenString;
    } catch (e: unknown) {
      handleRegistrationError(`${e}`);
    }
  } else {
    console.warn("In simulator: Push notifications disabled.");
  }
}

function handleRegistrationError(errorMessage: string) {
  alert(errorMessage);
  throw new Error(errorMessage);
}

const updateServer = async (locations: Location.LocationObject[]) => {
  const location = locations[0];
  console.debug("Received new location", location);

  // update the server
  const session = await AsyncStorage.getItem("session");
  console.debug("Using session", session);
  if (!session) {
    console.debug("No session found. Cannot update server!");
    return;
  }

  axios
    .post(`${HOST}/update`, location, {
      headers: {
        Authorization: `${session}`,
      },
    })
    .then((response) => console.debug("updated server:", response.status))
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
    console.debug("BACKGROUND LOCATIONS UPDATE");
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
  return Location.getForegroundPermissionsAsync().then(
    (p) => p.status === "granted"
  );
  // const [p1, p2] = await Promise.all([
  //   Location.getForegroundPermissionsAsync(),
  //   Location.getBackgroundPermissionsAsync(),
  // ]);
  // return p1.status === "granted" && p2.status === "granted";
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

type PermissionsState = {
  foregroundLocation?: Location.PermissionResponse;
  backgroundLocation?: Location.PermissionResponse;
  // TODO
  // pushNotifications?: Notifications.PermissionResponse;
};

type GlobalState = {
  session: string;
  page: Page;
  permissions: PermissionsState;
  users?: User[]; // SHOULD BE IN MAP
};

type GlobalProps = {
  state: GlobalState;
  setState: (update: (prevState: GlobalState) => GlobalState) => void;
};

async function getPermissions(): Promise<PermissionsState> {
  return {
    foregroundLocation: await Location.getForegroundPermissionsAsync(),
    backgroundLocation: await Location.getBackgroundPermissionsAsync(),
  };
}

async function refreshState(globalState: GlobalState): Promise<GlobalState> {
  const permissions = await getPermissions();
  const session = await AsyncStorage.getItem("session");

  return { ...globalState, permissions, session };
}

export default function Index() {
  // Context probably makes more sense here, whatever
  const [state, setState] = useState<GlobalState>({
    page: "loading",
    session: "",
    permissions: {},
  });

  // Keep the global app state up to date with local storage and permisison changes
  // every time the app is foregrounded or started.
  useEffect(() => {
    const handleAppStateChange = (nextAppState: string) => {
      if (nextAppState === "active") {
        console.log("app state changed to active - refreshing");
        refreshState(state).then(setState);
      }
    };

    const sub = AppState.addEventListener("change", handleAppStateChange);
    return () => sub.remove();
  }, []);

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
      if (!hasPermissions) {
        setState((state) => ({ ...state, ...diff, page: "request_location" }));
      } else if (validSession && hasPermissions) {
        await ensureLocationUpdatesStarted();
        setState((state) => ({ ...state, ...diff, page: "map" }));
      } else if (!validSession && hasPermissions) {
        setState((state) => ({ ...state, ...diff, page: "login" }));
      }
    })().catch((e) => {
      console.error("LoadingPage error", e);
    });
  }, []);

  return <Text>Loading...</Text>;
}

function LoginPage(props: GlobalProps) {
  const { state, setState } = props;
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: "1232840493696680038",
      redirectUri: AuthSession.makeRedirectUri({
        scheme: "com.ulirocks.miniworld",
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

      Promise.all([
        Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Lowest,
        }),
        // registerForPushNotificationsAsync(),
        null,
      ])
        .then(([location, pushToken]) => {
          return axios.post(`${HOST}/login/discord`, {
            code: code,
            code_verifier: request.codeVerifier,
            location: location,
            pushToken: pushToken,
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
    <>
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

      <Pressable
        style={styles.demoButton}
        onPress={() => {
          (async () => {
            const users = await getUsers("demo");
            await AsyncStorage.setItem("session", "demo");
            setState((state) => ({
              ...state,
              page: "map",
              session: "demo",
              users: users,
              hasPermissions: true,
            }));
          })();
        }}
      >
        <Text>Login in demo mode</Text>
      </Pressable>
    </>
  );
}

// TODO: This should be a Modal that floats above the map
function RequestLocationPage(props: GlobalProps) {
  const { setState } = props;

  const [locationFG, requestFG] = Location.useForegroundPermissions();

  return (
    <>
      <Text style={{ fontSize: 20, textAlign: "center", margin: 20 }}>
        LocShare needs location access to display you on the map.
      </Text>

      {locationFG?.canAskAgain ? (
        <Button
          title="Grant location permissions"
          onPress={() => {
            requestFG().then((status) => {
              if (status.granted) {
                setState((state) => ({ ...state, page: "loading" }));
              } else {
                alert("You must grant location permissions to use this app.");
              }
            });
          }}
        />
      ) : (
        <Text style={{ fontSize: 20, textAlign: "center", margin: 20 }}>
          We can't ask for location permissions again, please enable them in
          your settings.
          {
            " Settings > Apps > MiniWorld > Permissions > Location > Allow Always"
          }
        </Text>
      )}
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
    backgroundColor: "#232428",
  },
  avatar: {
    width: "100%",
    height: "100%",
  },
  demoButton: {
    color: "gray",
    marginTop: 20,
  },
});
