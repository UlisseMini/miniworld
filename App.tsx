import { useState, useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import MapView, { Marker } from "react-native-maps";
import { StyleSheet, Button, TextInput, View } from "react-native";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import axios from "axios";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as AuthSession from "expo-auth-session";

// WebBrowser.maybeCompleteAuthSession(); // web only; on mobile does nothing

const LOCATION_TASK_NAME = "background-location-task";
const HOST = "https://loc.uli.rocks";

const requestPermissions = async () => {
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

TaskManager.defineTask(LOCATION_TASK_NAME, ({ data, error }) => {
  if (error) {
    console.error(error);
    return;
  }

  const locations = (data as any).locations;
  if (locations) {
    console.log("Received new locations", locations);
    (async () => {
      // update user info in local storage
      const user: User = JSON.parse(await AsyncStorage.getItem("user"));
      await AsyncStorage.setItem(
        "user",
        JSON.stringify({ ...user, location: locations[0] })
      );
      console.log("updated user in storage", user);

      if (user.name === "") {
        console.error("update: no username set");
        return;
      }

      // update the server
      axios
        .post(`${HOST}/update`, user)
        .then((response) => console.log("updated server:", response.status))
        .catch((error) => console.error("update error:", error));
    })();
  }
});

type User = {
  name: string;
  location: Location.LocationObject;
};

const discovery = {
  authorizationEndpoint: "https://discord.com/api/oauth2/authorize",
  tokenEndpoint: "https://discord.com/api/oauth2/token",
  revocationEndpoint: "https://discord.com/api/oauth2/token/revoke",
};

export default function LoginScreen() {
  console.log("login screen render");
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

  useEffect(() => {
    console.log("request object", request);
  }, [request]);

  useEffect(() => {
    if (response?.type === "success") {
      const { code } = response.params;
      console.log("code", code);
      // attempt to get discord token

      // TODO: There's probably a better way of doing this.
      axios
        .post(`${HOST}/get_discord_token`, {
          code: code,
          code_verifier: request.codeVerifier,
        })
        .then((response) => {
          console.log("discord token response", response.data);
        })
        .catch((error) => {
          console.error("error", error);
        });
    }
  }, [response]);

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

  const [username, setUsername] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);

  // see if we're already logged in
  useEffect(() => {
    (async () => {
      const user = await AsyncStorage.getItem("user");
      const taskStarted = await Location.hasStartedLocationUpdatesAsync(
        LOCATION_TASK_NAME
      );

      if (user && taskStarted) {
        setLoggedIn(true);
      }
    })();
  }, []);

  if (loggedIn) {
    return <App />;
  } else {
    return (
      <View style={styles.container}>
        <TextInput
          placeholder="Username"
          onChange={(e) => {
            setUsername(e.nativeEvent.text);
          }}
        />

        <Button
          title="Login"
          onPress={async () => {
            if (username.trim() === "") {
              console.error("login: no username set");
              return;
            }

            const granted = await requestPermissions();
            if (!granted) {
              console.error("Permissions not granted");
              return;
            }

            const user: User = {
              name: username,
              location: await Location.getLastKnownPositionAsync(),
            };
            await AsyncStorage.setItem("user", JSON.stringify(user));

            setLoggedIn(true);
          }}
        />
      </View>
    );
  }
}

// Once we're inside App() we have username and location permissions
function App() {
  const [users, setUsers] = useState<User[]>([]);

  useEffect(() => {
    const updateUsers = () => {
      axios
        .get(`${HOST}/users`)
        .then((response) => {
          const change =
            JSON.stringify(users) !== JSON.stringify(response.data);
          if (change) {
            console.log("updated users (changed)");
          } else {
            console.log("updated users (no change)");
          }

          setUsers(response.data);
        })
        .catch((error) => {
          console.error("error", error);
        });
    };

    updateUsers();
    const interval = setInterval(() => updateUsers, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <View style={styles.container}>
      <MapView style={styles.map}>
        {users.map((user, index) => (
          <Marker
            key={index}
            coordinate={user.location.coords}
            title={`name: ${user.name}`}
          />
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
