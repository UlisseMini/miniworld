import React, { useState, useEffect } from "react";
import {
  View,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  StatusBar,
} from "react-native";
import { Text, Button, Divider } from "@rneui/themed";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";

// TODO: Import typechecking
export default function RequestLocation({ setState }: any) {
  const [canAsk, setCanAsk] = useState(false);
  const [fgGranted, setFgGranted] = useState(false);

  useEffect(() => {
    (async () => {
      const fg = await Location.getForegroundPermissionsAsync();
      const bg = await Location.getBackgroundPermissionsAsync();
      setCanAsk(fg.canAskAgain && bg.canAskAgain);
      setFgGranted(fg.granted);
    })().catch((e) => {
      console.error("RequestLocationPage error", e);
    });
  }, []);

  const handlePermissionRequest = async () => {
    const permPromise = fgGranted
      ? Location.requestBackgroundPermissionsAsync()
      : Location.requestForegroundPermissionsAsync();
    const p = await permPromise;
    if (p.granted) {
      setState((state: any) => ({ ...state, page: "loading" }));
    } else {
      setCanAsk(p.canAskAgain);
    }
  };

  const handleManualUpdates = async () => {
    await AsyncStorage.setItem("location-updates-disabled", "true");
    setState((state: any) => ({ ...state, page: "loading" }));
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#F5F5F5" />
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.scrollView}>
          <Text h1 style={styles.title}>
            Miniworld
          </Text>

          <Text style={styles.sectionTitle}>
            Miniworld needs background location access to:
          </Text>
          <View style={styles.infoSection}>
            <Text style={styles.bulletPoint}>
              • Keep your map location current
            </Text>
            <Text style={styles.bulletPoint}>
              • Alert you when friends are nearby
            </Text>
            <Text style={styles.bulletPoint}>
              • Share travel updates with friends
            </Text>
          </View>

          <Divider style={styles.divider} />

          <Text style={styles.sectionTitle}>Your privacy is our priority:</Text>
          <View style={styles.infoSection}>
            <Text style={styles.bulletPoint}>
              • Location accuracy: up to 3km
            </Text>
            <Text style={styles.bulletPoint}>
              • Your exact location stays on your device
            </Text>
          </View>

          <View style={styles.buttonContainer}>
            <Button
              title={`Grant ${
                fgGranted ? "Background" : "Foreground"
              } Location Access`}
              onPress={handlePermissionRequest}
              buttonStyle={styles.primaryButton}
              titleStyle={styles.primaryButtonText}
              disabled={!canAsk}
            />
            <Button
              title="Use Manual Location Updates"
              onPress={handleManualUpdates}
              buttonStyle={styles.secondaryButton}
              titleStyle={styles.secondaryButtonText}
            />
          </View>

          <Text style={styles.footer}>
            You can adjust this setting later in the app.
          </Text>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F5F5F5", // Light gray background
  },
  safeArea: {
    flex: 1,
  },
  scrollView: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingVertical: 20,
  },
  title: {
    color: "#333333", // Dark gray for main title
    marginBottom: 20,
    fontWeight: "bold",
    fontSize: 32,
  },
  sectionTitle: {
    color: "#4A4A4A", // Medium dark gray for section titles
    fontSize: 18,
    fontWeight: "bold",
    marginBottom: 10,
  },
  infoSection: {
    marginBottom: 20,
  },
  bulletPoint: {
    color: "#666666", // Medium gray for bullet points
    fontSize: 16,
    marginBottom: 5,
    marginLeft: 10,
  },
  divider: {
    backgroundColor: "#CCCCCC", // Light gray divider
    marginVertical: 20,
  },
  buttonContainer: {
    marginTop: 20,
  },
  primaryButton: {
    backgroundColor: "#333333", // Dark gray background for primary button
    borderRadius: 25,
    paddingVertical: 15,
    marginBottom: 10,
  },
  primaryButtonText: {
    color: "#FFFFFF", // White text for primary button
    fontSize: 16,
    fontWeight: "bold",
  },
  secondaryButton: {
    backgroundColor: "transparent",
    borderColor: "#666666", // Medium gray border for secondary button
    borderWidth: 2,
    borderRadius: 25,
    paddingVertical: 15,
  },
  secondaryButtonText: {
    color: "#4A4A4A", // Medium dark gray text for secondary button
    fontSize: 16,
  },
  footer: {
    color: "#888888", // Light medium gray for footer text
    textAlign: "center",
    marginTop: 20,
    fontSize: 14,
  },
});
