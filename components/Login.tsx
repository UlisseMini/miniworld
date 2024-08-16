import React, { useEffect } from "react";
import { View, StyleSheet, SafeAreaView } from "react-native";
import { Text, Button } from "@rneui/themed";
import * as AuthSession from "expo-auth-session";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";
import { StatusBar } from "expo-status-bar";
import { anonimizeLocation } from "../lib/utils";
import { HOST } from "../lib/constants";
import { GlobalProps } from "../lib/types";

const discovery = {
  authorizationEndpoint: "https://discord.com/api/oauth2/authorize",
  tokenEndpoint: "https://discord.com/api/oauth2/token",
};

function LoginPage({ setState }: GlobalProps) {
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

  useEffect(() => {
    if (response?.type === "success") {
      const { code } = response.params;
      handleSuccessfulLogin(code);
    } else if (response?.type === "error") {
      console.error("login error", response.error);
    }
  }, [response]);

  const handleSuccessfulLogin = async (code: any) => {
    try {
      const p = await Location.getForegroundPermissionsAsync();
      const autoUpdatingDisabled =
        (await AsyncStorage.getItem("location-updates-disabled")) !== null;
      const location =
        p.granted && !autoUpdatingDisabled
          ? anonimizeLocation(
              await Location.getCurrentPositionAsync({
                accuracy: Location.Accuracy.Lowest,
              })
            )
          : null;
      const pushToken = null; // registerForPushNotificationsAsync(),
      const response = await axios.post(`${HOST}/login/discord`, {
        code: code,
        code_verifier: request.codeVerifier,
        location: location,
        pushToken: pushToken,
      });
      const { session, users } = response.data;
      await AsyncStorage.setItem("session", session);
      setState((state) => ({ ...state, session, users, page: "loading" }));
    } catch (e) {
      console.error("login error", e);
    }
  };

  const handleDemoLogin = async () => {
    await AsyncStorage.setItem("session", "demo");
    setState((state) => ({
      ...state,
      page: "loading",
      session: "demo",
    }));
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      <View style={styles.content}>
        <Text h1 style={styles.title}>
          Miniworld
        </Text>
        <Text style={styles.subtitle}>
          Be notified when distant friends visit
        </Text>
        <View style={styles.buttonContainer}>
          <Button
            title="Login with Discord"
            onPress={() => promptAsync({ showInRecents: true })}
            disabled={!request}
            buttonStyle={styles.primaryButton}
            titleStyle={styles.primaryButtonText}
            icon={{
              name: "discord",
              type: "font-awesome-5",
              size: 20,
              color: "white",
            }}
            iconContainerStyle={styles.buttonIcon}
          />
          <Button
            title="Try Demo Mode"
            onPress={handleDemoLogin}
            buttonStyle={styles.secondaryButton}
            titleStyle={styles.secondaryButtonText}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
  content: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#333333",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: "#666666",
    marginBottom: 40,
    textAlign: "center",
  },
  buttonContainer: {
    width: "100%",
  },
  primaryButton: {
    backgroundColor: "#5865F2", // Discord blue
    borderRadius: 8,
    paddingVertical: 12,
    marginBottom: 12,
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "bold",
  },
  buttonIcon: {
    marginRight: 8,
  },
  secondaryButton: {
    backgroundColor: "transparent",
    borderColor: "#CCCCCC",
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 12,
  },
  secondaryButtonText: {
    color: "#333333",
    fontSize: 16,
  },
});

export default LoginPage;
