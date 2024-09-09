import React, { useState } from "react";
import {
  View,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  StatusBar,
} from "react-native";
import { Text, Button, Divider } from "@rneui/themed";
import * as Location from "expo-location";
import { GlobalProps } from "../lib/types";
import { registerForPushNotificationsAsync } from "../lib/notification";
import AsyncStorage from "@react-native-async-storage/async-storage";

export default function RequestLocation({ setState }: GlobalProps) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const slides = [
    {
      title: "Miniworld Needs Your Location",
      description:
        "To put you on the map. If you decline, you'll have to update your location manually by long-pressing on the map.",
      action: async () => {
        const { granted } = await Location.requestForegroundPermissionsAsync();
        return granted;
      },
    },
    {
      title: "Miniworld Needs to Always Know Your Location",
      description:
        "So you stay up to date even when you don't open the app. This allows us to notify you and your friends when you're traveling and end up in the same city.",
      action: async () => {
        const { granted } = await Location.requestBackgroundPermissionsAsync();
        return granted;
      },
    },
    {
      title: "Miniworld Needs Notification Permission",
      description:
        "So you can get notified when friends are visiting your city and vice versa.",
      action: async () => {
        const pushToken = await registerForPushNotificationsAsync();
        return !!pushToken;
      },
    },
  ];

  const handleNext = async () => {
    const slide = slides[currentSlide];
    const granted = await slide.action();

    // If they deny foreground location, skip to notification permission
    if (!granted && currentSlide === 0) {
      setCurrentSlide(2);
      return;
    }

    if (currentSlide < slides.length - 1) {
      setCurrentSlide(currentSlide + 1);
    } else {
      // Mark that we've asked for permissions
      await AsyncStorage.setItem('has-asked-for-permissions', 'true');
      setState((state: any) => ({ ...state, page: "loading" }));
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#F5F5F5" />
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.scrollView}>
          <Text style={styles.title}>
            {slides[currentSlide].title}
          </Text>

          <Text style={styles.description}>
            {slides[currentSlide].description}
          </Text>
        </ScrollView>

        <View style={styles.footer}>
          <Button
            title="Next"
            onPress={handleNext}
            buttonStyle={styles.nextButton}
            titleStyle={styles.nextButtonText}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F5F5F5",
  },
  safeArea: {
    flex: 1,
  },
  scrollView: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 100,
    justifyContent: "center",
  },
  title: {
    color: "#333333",
    marginBottom: 20,
    fontWeight: "bold",
    fontSize: 32,
    textAlign: "center",
  },
  description: {
    color: "#666666",
    fontSize: 16,
    textAlign: "center",
    marginBottom: 20,
  },
  divider: {
    backgroundColor: "#CCCCCC",
    marginVertical: 20,
  },
  footer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#F5F5F5",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: "#CCCCCC",
  },
  nextButton: {
    backgroundColor: "#333333",
    borderRadius: 25,
    paddingVertical: 15,
    marginVertical: 15,
  },
  nextButtonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "bold",
  },
});