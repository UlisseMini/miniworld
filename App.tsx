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
        // accuracy: Location.Accuracy.Lowest, // PRIVACY. TODO: BETTER SOLUTION
        accuracy: Location.Accuracy.Highest,
      });
      return true;
    }
  }
  return false;
};

const updateServer = async (locations: Location.LocationObject[]) => {
  const location = locations[0];

  console.log("Received new location", location);
  // update the server
  const session = JSON.parse(await AsyncStorage.getItem("session"));
  console.log("Using session", session);
  if (!session) {
    console.error("No session found. Cannot update server!");
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
    console.error(error);
    return;
  }

  const locations = (data as any).locations;
  if (locations) {
    updateServer(locations);
  }
});

type User = {
  name: string;
  avatar: string;
  location: Location.LocationObject;
};

const discovery = {
  authorizationEndpoint: "https://discord.com/api/oauth2/authorize",
  tokenEndpoint: "https://discord.com/api/oauth2/token",
  revocationEndpoint: "https://discord.com/api/oauth2/token/revoke",
};

// useState but for an async store
function useStore<T>(
  key: string,
  init: T,
  override?: boolean
): [T | null, any] {
  const [state, setState] = useState<T | null>(init);

  useEffect(() => {
    (async () => {
      if (override) await AsyncStorage.removeItem(key);

      const item = await AsyncStorage.getItem(key);
      if (item) {
        console.log(`loading ${key} -> ${item}`);
        setState(JSON.parse(item));
      }
    })();
  }, []);

  useEffect(() => {
    if (!state) return; // FIXME: Stupid hack
    (async () => {
      console.log(`setting ${key} -> ${state}`);
      await AsyncStorage.setItem(key, JSON.stringify(state));
      console.log(`set ${key} -> ${state}`);
    })();
  }, [state]);

  return [state, setState];
}

export default function LoginScreen() {
  const [session, setSession] = useStore<string>("session", null);
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

  // exchange discord code for session once we have it
  useEffect(() => {
    if (response?.type === "success") {
      const { code } = response.params;
      console.log("code", code);

      axios
        .post(`${HOST}/login/discord`, {
          code: code,
          code_verifier: request.codeVerifier,
        })
        .then((response) => setSession(response.data.session))
        .catch((error) => console.error("login:", error));
    }
  }, [response]);

  if (!session) {
    return (
      <View style={styles.container}>
        <Button
          disabled={!request}
          title="Login with discord"
          onPress={() => {
            // showInRecents: true is required for 2fa on android
            promptAsync({ showInRecents: true });
          }}
        />
      </View>
    );
  } else {
    return <AcquireLocation session={session} />;
  }
}

function AcquireLocation(props: { session: string }) {
  const [granted, setGranted] = useState(false);

  // If we have permissions, set granted to true
  useEffect(() => {
    (async () => {
      const [p1, p2, started] = await Promise.all([
        Location.getForegroundPermissionsAsync(),
        Location.getBackgroundPermissionsAsync(),
        Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME),
      ]);

      console.log("permissions", p1, p2, "started", started);
      setGranted(p1.status === "granted" && p2.status === "granted" && started);
    })();
  }, []);

  if (!granted) {
    return (
      <View style={styles.container}>
        <Button
          title="Grant background location permissions"
          onPress={() => {
            requestLocationPermissions()
              .then((granted) => {
                console.log("granted", granted);
                setGranted(granted);
              })
              .catch((error) => {
                console.error("granting location permissions", error);
              });
          }}
        />
      </View>
    );
  } else {
    return <App session={props.session} />;
  }
}

function App(props: { session: string }) {
  const [users, setUsers] = useState<User[]>([]);

  // Update server with our location once at startup
  useEffect(() => {
    (async () => {
      const location = await Location.getCurrentPositionAsync();
      await updateServer([location]);
    })();
  }, []);

  // Update users periodically
  useEffect(() => {
    const updateUsers = () => {
      axios
        .get(`${HOST}/users`, {
          headers: {
            Authorization: `${props.session}`,
          },
        })
        .then((response) => {
          const changed =
            JSON.stringify(users) !== JSON.stringify(response.data);
          console.log(
            "updated users" + (changed ? "(changed)" : "(no change)")
          );
          console.log(JSON.stringify(response.data, null, 2));
          setUsers(response.data);
        })
        .catch((error) => {
          console.error("update users", error);
        });
    };

    updateUsers();
    const interval = setInterval(() => updateUsers, 1000);
    return () => clearInterval(interval);
  }, []);

  const coords = users[0]?.location?.coords;
  const region = coords
    ? {
        latitude: coords.latitude,
        longitude: coords.longitude,
        latitudeDelta: 0.922,
        longitudeDelta: 0.421,
      }
    : null;

  return (
    <View style={styles.container}>
      <MapView style={styles.map} provider={PROVIDER_GOOGLE} region={region}>
        {users
          .filter((u) => !!u.location)
          .map((user, index) => (
            <Marker
              key={index}
              coordinate={user.location.coords}
              title={`name: ${user.name}`}
            >
              {/* <Image */}
              {/*   source={{ uri: user.avatar }} */}
              {/*   style={{ width: 50, height: 50 }} */}
              {/* /> */}
            </Marker>
          ))}
      </MapView>
      <StatusBar style="auto" />
    </View>
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
});
