/** Website-behavior signal kinds a campaign trigger can require (client-safe; no server imports). */
export const WEB_SIGNAL_LABELS = {
  any_visit: "Visited the website",
  viewed_product: "Viewed the camper page",
  viewed_builder: "Opened the 3D builder",
  viewed_financing: "Viewed financing",
  watched_video: "Watched a video",
  phone_click: "Tapped the phone number",
  cart_click: "Clicked reserve / deposit / pay",
} as const;
export type WebSignalKind = keyof typeof WEB_SIGNAL_LABELS;
