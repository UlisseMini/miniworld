import { useState, useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";
import {
  StyleSheet,
  Text,
  View,
  Platform,
  AppState,
  Alert,
  TouchableOpacity,
  Switch,
  ScrollView,
} from "react-native";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import axios from "axios";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import * as Notifications from "expo-notifications";
import { MaterialIcons } from "@expo/vector-icons";
import * as ScreenOrientation from "expo-screen-orientation";
import RequestLocationPage from "./components/RequestLocation";
import LoginPage from "./components/Login";
import {
  User,
  PermissionsState,
  RefreshableState,
  Page,
  GlobalState,
  GlobalProps,
} from "./lib/types";
import { anonimizeLocation } from "./lib/utils";
import { HOST } from "./lib/constants";

const LOCATION_TASK_NAME = "background-location-task";

console.debug = () => { }; // disable debug logs

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

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
    updateServer(locations.map(anonimizeLocation));
  }
});

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

const ensureLocationUpdates = async () => {
  if (await AsyncStorage.getItem("location-updates-disabled") !== null) {
    console.log("location updates disabled. not starting.");
    return;
  }

  const started = await Location.hasStartedLocationUpdatesAsync(
    LOCATION_TASK_NAME
  );

  if (!started) {
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.Lowest,
      deferredUpdatesDistance: 3000, // if they haven't moved 3km don't update
      deferredUpdatesInterval: 1000 * 60 * 60, // update at most once every hour
    });
  }
};

async function getPermissions(): Promise<PermissionsState> {
  return {
    foregroundLocation: await Location.getForegroundPermissionsAsync(),
    backgroundLocation: await Location.getBackgroundPermissionsAsync(),
  };
}

async function getPage(state: RefreshableState): Promise<Page> {
  const { session, permissions, users } = state;

  const locationUpdatesDisabled =
    (await AsyncStorage.getItem("location-updates-disabled")) !== null;
  const hasAskedForPermissions =
    await AsyncStorage.getItem('has-asked-for-permissions') === 'true';

  const validSession = !!session && !!users;
  const hasPermissions =
    permissions.foregroundLocation?.granted &&
    permissions.backgroundLocation?.granted;

  console.log(`valid session?: ${validSession} perms?: ${hasPermissions}`);

  if (!validSession) return "login";

  if (!hasPermissions && !locationUpdatesDisabled && !hasAskedForPermissions) return "request_location";

  return "map";
}

async function refreshState(): Promise<RefreshableState> {
  const permissions = await getPermissions();
  const session = await AsyncStorage.getItem("session");
  const users = session
    ? await getUsers(session).catch((e) =>
      console.warn(`refreshState: error getting users: ${e}`)
    )
    : null;

  return { permissions, session, users };
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
    const handleAppStateChange = async (nextAppState: string) => {
      if (nextAppState === "active") {
        console.log("app state changed to active - refreshing");
        const diff = await refreshState();
        const page = await getPage(diff);
        setState((state) => ({ ...state, ...diff, page }));
      }
    };

    const sub = AppState.addEventListener("change", handleAppStateChange);
    return () => sub.remove();
  }, []);

  // Fix screen orientation (support all orientations)
  useEffect(() => {
    ScreenOrientation.unlockAsync()
      .then(() => console.log("Screen orientation unlocked"))
      .catch((e) => console.error("Screen orientation error", e));
  }, []);

  // load the correct page
  const props = { state, setState };
  const pageComponent = {
    loading: () => <LoadingPage {...props} />,
    login: () => <LoginPage {...props} />,
    request_location: () => <RequestLocationPage {...props} />,
    map: () => <MapPage {...props} />,
    settings: () => <SettingsPage {...props} />,
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
      const diff = await refreshState();
      const page = await getPage(diff);
      if (page === "map") await ensureLocationUpdates();
      setState((state) => ({ ...state, ...diff, page }));
    })().catch((e) => {
      console.error("LoadingPage error", e);
    });
  }, []);

  return <Text>Loading...</Text>;
}

function MapPage(props: GlobalProps) {
  const { users } = props.state;

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
    <>
      <MapView
        style={styles.map}
        provider={PROVIDER_GOOGLE}
        initialRegion={region}
        moveOnMarkerPress={false}
        onLongPress={async (e) => {
          console.log("user long-pressed at", e.nativeEvent.coordinate);
          // Popup asking if the user would like to set their location there.
          const location: Location.LocationObject = anonimizeLocation({
            coords: {
              latitude: e.nativeEvent.coordinate.latitude,
              longitude: e.nativeEvent.coordinate.longitude,
              altitude: null,
              accuracy: null,
              altitudeAccuracy: null,
              heading: null,
              speed: null,
            },
            timestamp: Date.now(),
          });

          const onConfirm = async () => {
            // stop location updates
            await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME).catch(
              () => null
            );
            await AsyncStorage.setItem("location-updates-disabled", "true");

            // update server and app state
            await updateServer([location]);

            const users = await getUsers(props.state.session);
            props.setState((state) => ({
              ...state,
              users,
            }));
          };

          // check if they've already seen the confirmation dialog
          const needToConfirm =
            (await AsyncStorage.getItem("location-updates-disabled")) === null;
          if (!needToConfirm) {
            // don't need confirmation -- they've already seen it.
            await onConfirm();
            return;
          }

          Alert.alert(
            "Set your location here?",
            "This will update your location on the map and disable automatic updates.",
            [
              {
                text: "Cancel",
                style: "cancel",
              },
              {
                text: "Set",
                style: "default",
                onPress: onConfirm,
              },
            ]
          );
        }}
      >
        {users.map((user, index) => {
          // const latlon = user.location.coords;
          // console.log(`${user.name} at ${latlon.latitude}, ${latlon.longitude}`);

          return <UserMarker key={index} user={user} />;
        })}
      </MapView>

      <MaterialIcons
        name="settings"
        size={24}
        color="black"
        style={styles.settingsButton}
        onPress={() => props.setState(state => ({ ...state, page: 'settings' }))}
      />
    </>
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
  const [tracksViewChanges, setTracksViewChanges] = useState(true);
  const user = props.user;

  const defaultAvatarNumber = user.name ? parseInt(user.name.charCodeAt(0).toString().slice(-1)) % 5 : 0;
  const avatarUrl = user.avatar_url || `https://cdn.discordapp.com/embed/avatars/${defaultAvatarNumber}.png`;

  return (
    <Marker
      tracksViewChanges={tracksViewChanges}
      coordinate={user.location.coords}
      title={`${user.name}`}
      description={`servers: ${user.duser.guilds
        .map((g) => g.name)
        .join(", ")}`}
    >
      <View style={styles.avatarContainer}>
        <Image
          style={styles.avatar}
          source={avatarUrl}
          onLoadEnd={() => setTracksViewChanges(false)}
          contentFit="cover"
        />
      </View>
    </Marker>
  );
}

function SettingsPage(props: GlobalProps) {
  const [autoUpdate, setAutoUpdate] = useState(true);
  const currentUser = props.state.users?.[0];
  const guilds = currentUser?.duser?.guilds || [];
  const guildSharing = currentUser?.settings?.guild_sharing || {};

  const toggleGuild = async (guildId: string) => {
    if (!currentUser) return;

    const newGuildSharing = {
      ...guildSharing,
      [guildId]: !guildSharing[guildId]
    };

    try {
      await axios.post(`${HOST}/settings`, {
        guild_sharing: newGuildSharing
      }, {
        headers: {
          Authorization: props.state.session
        }
      });

      // Optimistically update the UI
      props.setState(state => ({
        ...state,
        users: state.users?.map(user =>
          user === currentUser
            ? {
              ...user,
              settings: {
                ...user.settings,
                guild_sharing: newGuildSharing
              }
            }
            : user
        )
      }));
    } catch (error) {
      console.error('Failed to update settings:', error);
    }
  };

  // Load initial state
  useEffect(() => {
    AsyncStorage.getItem("location-updates-disabled")
      .then(disabled => setAutoUpdate(!disabled))
      .catch(console.error);
  }, []);

  const toggleAutoUpdate = async (value: boolean) => {
    setAutoUpdate(value);
    if (value) {
      // Enable automatic updates
      await AsyncStorage.removeItem("location-updates-disabled");
      await ensureLocationUpdates();
    } else {
      // Disable automatic updates
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME).catch(() => null);
      await AsyncStorage.setItem("location-updates-disabled", "true");
    }
  };

  return (
    <View style={styles.settingsContainer}>
      <View style={styles.settingsHeader}>
        <MaterialIcons
          name="arrow-back"
          size={24}
          color="black"
          onPress={() => props.setState(state => ({ ...state, page: 'map' }))}
          style={styles.backButton}
        />
        <Text style={styles.settingsTitle}>Settings</Text>
      </View>

      <ScrollView style={styles.settingsList}>
        <View style={styles.settingsSection}>
          <Text style={styles.settingsSectionTitle}>Location Updates</Text>
          <View style={styles.settingsItem}>
            <View style={styles.settingsItemLeft}>
              <MaterialIcons name="my-location" size={24} color="black" />
              <Text style={styles.settingsItemText}>Update location automatically</Text>
            </View>
            <Switch
              value={autoUpdate}
              onValueChange={toggleAutoUpdate}
            />
          </View>
        </View>

        <View style={[styles.settingsSection, styles.settingsSectionMargin]}>
          <Text style={styles.settingsSectionTitle}>Share Location With</Text>
          {guilds.map((guild, index) => (
            <View
              key={guild.id}
              style={[
                styles.settingsItem,
                index > 0 && styles.settingsItemMargin
              ]}
            >
              <View style={styles.settingsItemLeft}>
                {guild.icon ? (
                  <Image
                    source={`https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png`}
                    style={styles.guildIcon}
                    contentFit="cover"
                  />
                ) : (
                  <View style={[styles.guildIcon, styles.defaultGuildIcon]}>
                    <Text style={styles.defaultGuildText}>
                      {guild.name.slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                )}
                <Text style={styles.settingsItemText}>{guild.name}</Text>
              </View>
              <Switch
                value={guildSharing[guild.id] ?? false}
                onValueChange={() => toggleGuild(guild.id)}
              />
            </View>
          ))}
        </View>

        <View style={[styles.settingsSection, styles.settingsSectionMargin]}>
          <Text style={styles.settingsSectionTitle}>Account</Text>
          <TouchableOpacity
            style={[styles.settingsItem, styles.logoutButton]}
            onPress={async () => {
              await AsyncStorage.clear();
              props.setState((state) => ({ ...state, page: "loading" }));
            }}
          >
            <View style={styles.settingsItemLeft}>
              <MaterialIcons name="logout" size={24} color="#FF3B30" />
              <Text style={[styles.settingsItemText, styles.logoutText]}>Logout</Text>
            </View>
          </TouchableOpacity>
        </View>
      </ScrollView>
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
  defaultButton: {
    backgroundColor: "blue",
    padding: 15,
    borderRadius: 5,
    margin: 20,
  },
  defaultButtonText: {
    fontSize: 20,
    color: "white",
    textAlign: "center",
  },
  demoButton: {
    marginTop: 30,
    backgroundColor: "gray",
    padding: 10,
    borderRadius: 5,
    maxWidth: 300,
  },
  demoButtonText: {
    fontSize: 14,
    color: "white",
    textAlign: "center",
  },
  logoutButton: {
    backgroundColor: '#FFE5E5',
  },
  logoutText: {
    color: '#FF3B30',
    fontWeight: '500',
  },
  settingsButton: {
    position: "absolute",
    top: Platform.OS === "ios" ? 40 : 25,
    right: 10,
    padding: 10,
  },
  settingsContainer: {
    flex: 1,
    width: '100%',
    backgroundColor: '#fff',
  },
  settingsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    paddingTop: Platform.OS === "ios" ? 60 : 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  backButton: {
    marginRight: 16,
  },
  settingsTitle: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  settingsList: {
    padding: 16,
  },
  settingsItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 8,
    backgroundColor: '#f5f5f5',
    justifyContent: 'space-between',
  },
  settingsItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  settingsItemMargin: {
    marginTop: 16,
  },
  settingsItemText: {
    marginLeft: 16,
    fontSize: 16,
  },
  settingsSection: {
    backgroundColor: '#f5f5f5',
    borderRadius: 12,
    padding: 16,
  },
  settingsSectionMargin: {
    marginTop: 24,
  },
  settingsSectionTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: '#666',
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  guildIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
  },
  defaultGuildIcon: {
    backgroundColor: '#7289da',
    justifyContent: 'center',
    alignItems: 'center',
  },
  defaultGuildText: {
    color: 'white',
    fontSize: 14,
    fontWeight: 'bold',
  },
});