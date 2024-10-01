import * as Location from "expo-location";

export function anonimizeLocation(
  location: Location.LocationObject
): Location.LocationObject {
  // Round lat/lon to 2 decimals. Works out to 2-3km accuracy.
  location.coords.latitude = Math.round(location.coords.latitude * 100) / 100;
  location.coords.longitude = Math.round(location.coords.longitude * 100) / 100;
  return location;
}
