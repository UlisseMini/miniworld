import * as Location from "expo-location";

export type Guild = {
  name: string;
  icon: string | null; // url
};

export type User = {
  name: string;
  avatar_url: string;
  location: Location.LocationObject;
  common_guilds: Guild[];
};

export type PermissionsState = {
  foregroundLocation?: Location.PermissionResponse;
  backgroundLocation?: Location.PermissionResponse;
  // TODO
  // pushNotifications?: Notifications.PermissionResponse;
};

export type RefreshableState = {
  session: string;
  permissions: PermissionsState;
  users?: User[];
};

export type Page = "loading" | "login" | "request_location" | "map" | "settings";

export type GlobalState = RefreshableState & {
  page: Page;
};

export type GlobalProps = {
  state: GlobalState;
  setState: (update: (prevState: GlobalState) => GlobalState) => void;
};
