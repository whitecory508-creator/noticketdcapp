import React, { useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Preferences } from "@capacitor/preferences";
import "leaflet/dist/leaflet.css";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Popup,
  Polyline,
  useMap,
} from "react-leaflet";

const MAPBOX_ACCESS_TOKEN =
  "pk.eyJ1Ijoibm90aWNrZXRkYyIsImEiOiJjbW85M3R2azQwNWQyMnFxNWpsZWtnenVzIn0.nbseqgxasMJptlzC2A8qbw";

const DC_CAMERA_API =
  "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Public_Safety_WebMercator/MapServer/47/query?f=json&where=1%3D1&outFields=ENFORCEMENT_SPACE_CODE,LOCATION_DESCRIPTION,SITE_CODE,ACTIVE_STATUS,CAMERA_STATUS,DEVICE_MOBILITY,ENFORCEMENT_TYPE,SPEED_LIMIT,CAMERA_LATITUDE,CAMERA_LONGITUDE,WARD,ANC,SMD,OBJECTID";

const PREF_KEYS = {
  voiceEnabled: "noticket_voice_enabled",
  alertRadiusFeet: "noticket_alert_radius_feet",
  showSpeed: "noticket_show_speed",
  showRedLight: "noticket_show_red_light",
  showOther: "noticket_show_other",
  recentSearches: "noticket_recent_searches",
};

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function distanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function metersToFeet(meters) {
  return meters * 3.28084;
}

function formatDistance(meters) {
  if (!isFinite(meters)) return "--";
  const feet = metersToFeet(meters);
  if (feet < 528) return `${Math.round(feet)} ft`;
  return `${(feet / 5280).toFixed(2)} mi`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hrs} hr` : `${hrs} hr ${rem} min`;
}

function getHeadingDegrees(coords) {
  const heading =
    coords && typeof coords.heading === "number" ? coords.heading : null;
  return Number.isFinite(heading) ? heading : null;
}

function getCardinalDirection(heading) {
  if (!Number.isFinite(heading)) return "--";
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return directions[Math.round(heading / 45) % 8];
}

function bearingBetweenPoints(lat1, lon1, lat2, lon2) {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const lambda1 = toRadians(lon1);
  const lambda2 = toRadians(lon2);

  const y = Math.sin(lambda2 - lambda1) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(lambda2 - lambda1);

  const theta = Math.atan2(y, x);
  return ((theta * 180) / Math.PI + 360) % 360;
}

function smallestAngleDifference(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function isLikelyAhead(userHeading, bearingToCamera) {
  if (!Number.isFinite(userHeading) || !Number.isFinite(bearingToCamera)) {
    return true;
  }
  return smallestAngleDifference(userHeading, bearingToCamera) <= 70;
}

function toBool(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  return value === "true";
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 50 ? parsed : fallback;
}

async function savePref(key, value) {
  await Preferences.set({ key, value: String(value) });
}

async function loadPrefs() {
  const entries = await Promise.all(
    Object.values(PREF_KEYS).map((key) => Preferences.get({ key }))
  );

  const result = {};
  Object.values(PREF_KEYS).forEach((key, index) => {
    result[key] = entries[index]?.value ?? null;
  });
  return result;
}

async function saveRecentSearches(searches) {
  await Preferences.set({
    key: PREF_KEYS.recentSearches,
    value: JSON.stringify(searches),
  });
}

function isNativeApp() {
  return Capacitor.isNativePlatform();
}

async function requestLocationPermission() {
  const permissions = await Geolocation.requestPermissions();
  return (
    permissions.location === "granted" ||
    permissions.coarseLocation === "granted"
  );
}

async function requestNotificationPermission() {
  const permission = await LocalNotifications.requestPermissions();
  return permission.display === "granted";
}

async function getFreshPosition() {
  if (isNativeApp()) {
    return Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 5000,
    });
  }

  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not supported on this device/browser."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      (err) => reject(err),
      {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 5000,
      }
    );
  });
}

function speakText(text) {
  if (typeof window === "undefined" || !window.speechSynthesis || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  utterance.volume = 1;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

async function fireLocalNotification(title, body, id) {
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id,
          title,
          body,
          schedule: { at: new Date(Date.now() + 250) },
        },
      ],
    });
  } catch (error) {
    console.error("Notification error", error);
  }
}

function getCameraAlertText(camera, distanceFeet) {
  const rounded = Math.max(25, Math.round(distanceFeet / 25) * 25);

  if (camera.type === "speed") {
    return `Speed camera ahead in ${rounded} feet. Please obey posted speed limit.`;
  }

  if (camera.type === "red_light") {
    return `Red light camera ahead in ${rounded} feet.`;
  }

  if (camera.type === "stop_sign") {
    return "Stop sign camera ahead. Please come to a complete stop before the white line and remain for 2 to 5 seconds before you proceed.";
  }

  if (camera.type === "bus_lane" || camera.type === "truck") {
    return `Traffic enforcement camera ahead in ${rounded} feet.`;
  }

  return `Traffic camera ahead in ${rounded} feet.`;
}

function pointToSegmentDistanceMeters(point, start, end) {
  const [px, py] = point;
  const [x1, y1] = start;
  const [x2, y2] = end;

  const dx = x2 - x1;
  const dy = y2 - y1;

  if (dx === 0 && dy === 0) {
    return distanceInMeters(py, px, y1, x1);
  }

  const t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, t));
  const closestX = x1 + clamped * dx;
  const closestY = y1 + clamped * dy;

  return distanceInMeters(py, px, closestY, closestX);
}

function isCameraNearRoute(camera, routeCoords, thresholdMeters = 120) {
  if (!routeCoords || routeCoords.length < 2) return false;

  const point = [camera.lng, camera.lat];

  for (let i = 0; i < routeCoords.length - 1; i++) {
    const start = [routeCoords[i][1], routeCoords[i][0]];
    const end = [routeCoords[i + 1][1], routeCoords[i + 1][0]];
    const distance = pointToSegmentDistanceMeters(point, start, end);
    if (distance <= thresholdMeters) return true;
  }

  return false;
}

function distanceToRouteMeters(lat, lng, routeCoords) {
  if (!routeCoords || routeCoords.length < 2) return Infinity;

  const point = [lng, lat];
  let minDistance = Infinity;

  for (let i = 0; i < routeCoords.length - 1; i++) {
    const start = [routeCoords[i][1], routeCoords[i][0]];
    const end = [routeCoords[i + 1][1], routeCoords[i + 1][0]];
    const distance = pointToSegmentDistanceMeters(point, start, end);
    if (distance < minDistance) minDistance = distance;
  }

  return minDistance;
}

function getStepProgressDistance(step, lat, lng) {
  const intersections = Array.isArray(step?.intersections)
    ? step.intersections
    : [];
  if (intersections.length === 0) {
    const loc = step?.maneuver?.location;
    if (!Array.isArray(loc) || loc.length < 2) return Infinity;
    return distanceInMeters(lat, lng, loc[1], loc[0]);
  }

  let minDistance = Infinity;
  for (const item of intersections) {
    const loc = item?.location;
    if (!Array.isArray(loc) || loc.length < 2) continue;
    const d = distanceInMeters(lat, lng, loc[1], loc[0]);
    if (d < minDistance) minDistance = d;
  }
  return minDistance;
}

function stripHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/<[^>]+>/g, "")
    .trim();
}

function buildStepInstruction(step) {
  const type = step?.maneuver?.type || "continue";
  const modifier = step?.maneuver?.modifier || "";
  const name = step?.name || "";
  const cleanedModifier = modifier === "straight" ? "straight" : modifier;

  if (type === "depart") return `Start on ${name || "the road"}`;
  if (type === "arrive") return "You have arrived at your destination";
  if (type === "roundabout") {
    return `Enter the roundabout${name ? ` toward ${name}` : ""}`;
  }
  if (type === "turn") {
    return `Turn ${cleanedModifier || "ahead"}${name ? ` onto ${name}` : ""}`;
  }
  if (type === "merge") {
    return `Merge${name ? ` onto ${name}` : ""}`;
  }
  if (type === "fork") {
    return `Keep ${cleanedModifier || "forward"}${
      name ? ` toward ${name}` : ""
    }`;
  }
  if (type === "end of road") {
    return `At the end of the road, turn ${cleanedModifier || "ahead"}${
      name ? ` onto ${name}` : ""
    }`;
  }
  if (type === "new name") {
    return `Continue onto ${name || "the road"}`;
  }
  if (type === "on ramp") {
    return `Take the ramp${name ? ` to ${name}` : ""}`;
  }
  if (type === "off ramp") {
    return `Take the exit${name ? ` toward ${name}` : ""}`;
  }

  return name ? `Continue on ${name}` : "Continue straight";
}

function getMapboxVoiceInstruction(step, mode = "main") {
  const voiceInstructions = Array.isArray(step?.voiceInstructions)
    ? step.voiceInstructions
    : [];

  if (!voiceInstructions.length) return "";

  if (mode === "early") {
    const sorted = [...voiceInstructions].sort(
      (a, b) => (b.distanceAlongGeometry || 0) - (a.distanceAlongGeometry || 0)
    );
    return stripHtml(sorted[0]?.announcement || "");
  }

  const sorted = [...voiceInstructions].sort(
    (a, b) => (a.distanceAlongGeometry || 0) - (b.distanceAlongGeometry || 0)
  );
  return stripHtml(sorted[0]?.announcement || "");
}

function getSpokenInstruction(step, mode = "main") {
  const fromMapbox = getMapboxVoiceInstruction(step, mode);
  if (fromMapbox) return fromMapbox;

  const fallback = buildStepInstruction(step);
  if (mode === "early" && fallback) {
    return `Ahead, ${fallback.toLowerCase()}`;
  }
  return fallback;
}

function getCameraColor(camera) {
  if (camera.type === "speed") return "#ef4444";
  if (camera.type === "red_light") return "#f59e0b";
  if (camera.type === "stop_sign") return "#8b5cf6";
  return "#3b82f6";
}

async function searchPlaces(query) {
  if (!query || query.trim().length < 2) return [];

  const url =
    "https://api.mapbox.com/search/geocode/v6/forward?q=" +
    encodeURIComponent(query.trim()) +
    "&bbox=-77.65,37.85,-76.85,39.75" +
    "&country=US" +
    "&limit=8" +
    `&access_token=${encodeURIComponent(MAPBOX_ACCESS_TOKEN)}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Place search failed.");
  }

  const data = await response.json();
  const features = Array.isArray(data.features) ? data.features : [];

  return features
    .map((feature) => {
      const coords = feature?.geometry?.coordinates || [];
      return {
        id:
          feature.properties?.mapbox_id ||
          feature.id ||
          Math.random().toString(36),
        name:
          feature.properties?.name ||
          feature.properties?.full_address ||
          "Destination",
        subtitle:
          feature.properties?.full_address ||
          feature.properties?.place_formatted ||
          "",
        full:
          feature.properties?.full_address ||
          feature.properties?.name ||
          "Destination",
        lng: Number(coords[0]),
        lat: Number(coords[1]),
      };
    })
    .filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng));
}

async function getRoute(originLat, originLng, destLat, destLng) {
  if (
    !Number.isFinite(originLat) ||
    !Number.isFinite(originLng) ||
    !Number.isFinite(destLat) ||
    !Number.isFinite(destLng)
  ) {
    throw new Error(
      "Route could not be built because location coordinates are missing."
    );
  }

  const coordinates = `${originLng},${originLat};${destLng},${destLat}`;
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coordinates}` +
    `?alternatives=true` +
    `&geometries=geojson` +
    `&steps=true` +
    `&voice_instructions=true` +
    `&banner_instructions=true` +
    `&overview=full` +
    `&annotations=distance,duration,speed` +
    `&access_token=${encodeURIComponent(MAPBOX_ACCESS_TOKEN)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`Route request failed (${response.status}).`);
    }

    const data = await response.json();

    if (!data.routes || !data.routes.length) {
      throw new Error("No driving route was found.");
    }

    const route = data.routes[0];
    const alternatives = data.routes.slice(1, 3).map((r, index) => ({
      id: `alt-${index + 1}`,
      distanceMeters: r.distance,
      durationSeconds: r.duration,
      geometry: r.geometry?.coordinates || [],
      steps: (r.legs || []).flatMap((leg) => leg.steps || []),
    }));

    const legs = route.legs || [];
    const steps = legs.flatMap((leg) => leg.steps || []);

    return {
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      geometry: route.geometry?.coordinates || [],
      steps,
      alternatives,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Route request timed out. Please try again.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function RecenterMap({ center, zoom }) {
  const map = useMap();

  useEffect(() => {
    if (center && Array.isArray(center)) {
      map.setView(center, zoom ?? map.getZoom(), { animate: true });
    }
  }, [center, zoom, map]);

  return null;
}

export default function App() {
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [started, setStarted] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [position, setPosition] = useState(null);
  const [status, setStatus] = useState(
    "Loading Washington, DC traffic camera database..."
  );
  const [lastAlert, setLastAlert] = useState(
    "Waiting for nearby traffic camera alerts."
  );
  const [locationError, setLocationError] = useState("");
  const [cameraError, setCameraError] = useState("");
  const [alertRadiusFeet, setAlertRadiusFeet] = useState(500);
  const [cameraData, setCameraData] = useState([]);
  const [showSpeed, setShowSpeed] = useState(true);
  const [showRedLight, setShowRedLight] = useState(true);
  const [showOther, setShowOther] = useState(false);
  const [alertHistory, setAlertHistory] = useState([]);
  const [permissionReady, setPermissionReady] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [destination, setDestination] = useState(null);
  const [routeCoords, setRouteCoords] = useState([]);
  const [routeInfo, setRouteInfo] = useState(null);
  const [routeSteps, setRouteSteps] = useState([]);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState("");
  const [recentSearches, setRecentSearches] = useState([]);
  const [searching, setSearching] = useState(false);
  const [isNavigating, setIsNavigating] = useState(false);
  const [navStepIndex, setNavStepIndex] = useState(0);
  const [alternativeRoutes, setAlternativeRoutes] = useState([]);
  const [rerouting, setRerouting] = useState(false);

  const watchIdRef = useRef(null);
  const spokenCameraIdsRef = useRef({});
  const insideRadiusIdsRef = useRef({});
  const nativeWatchCallbackIdRef = useRef(null);

  const spokenEarlyStepRef = useRef(new Set());
  const spokenMainStepRef = useRef(new Set());
  const lastRerouteAtRef = useRef(0);
  const arrivalSpokenRef = useRef(false);
  const navStartedSpokenRef = useRef(false);

  useEffect(() => {
    async function bootstrap() {
      try {
        const prefs = await loadPrefs();
        setVoiceEnabled(toBool(prefs[PREF_KEYS.voiceEnabled], true));
        setAlertRadiusFeet(toNumber(prefs[PREF_KEYS.alertRadiusFeet], 500));
        setShowSpeed(toBool(prefs[PREF_KEYS.showSpeed], true));
        setShowRedLight(toBool(prefs[PREF_KEYS.showRedLight], true));
        setShowOther(toBool(prefs[PREF_KEYS.showOther], false));

        const recentRaw = prefs[PREF_KEYS.recentSearches];
        try {
          setRecentSearches(recentRaw ? JSON.parse(recentRaw) : []);
        } catch {
          setRecentSearches([]);
        }
      } finally {
        setPrefsLoaded(true);
      }
    }

    bootstrap();
  }, []);

  useEffect(() => {
    if (!prefsLoaded) return;
    savePref(PREF_KEYS.voiceEnabled, voiceEnabled);
  }, [voiceEnabled, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) return;
    savePref(PREF_KEYS.alertRadiusFeet, alertRadiusFeet);
  }, [alertRadiusFeet, prefsLoaded]);

  useEffect(() => {
    if (!prefsLoaded) return;
    savePref(PREF_KEYS.showSpeed, showSpeed);
    savePref(PREF_KEYS.showRedLight, showRedLight);
    savePref(PREF_KEYS.showOther, showOther);
  }, [showSpeed, showRedLight, showOther, prefsLoaded]);

  useEffect(() => {
    async function loadCameras() {
      try {
        setCameraError("");
        const response = await fetch(DC_CAMERA_API);
        const data = await response.json();
        const features = Array.isArray(data.features) ? data.features : [];

        const mapped = features
          .map((item) => {
            const a = item.attributes || {};
            const lat = Number(a.CAMERA_LATITUDE);
            const lng = Number(a.CAMERA_LONGITUDE);
            const typeRaw = String(a.ENFORCEMENT_TYPE || "").toLowerCase();

            let type = "other";
            if (typeRaw.includes("speed")) type = "speed";
            else if (typeRaw.includes("red")) type = "red_light";
            else if (typeRaw.includes("stop")) type = "stop_sign";
            else if (typeRaw.includes("truck")) type = "truck";
            else if (typeRaw.includes("bus")) type = "bus_lane";

            return {
              id:
                a.OBJECTID ||
                a.SITE_CODE ||
                `${a.ENFORCEMENT_SPACE_CODE}-${lat}-${lng}`,
              type,
              typeLabel: a.ENFORCEMENT_TYPE || "Camera",
              name:
                a.ENFORCEMENT_SPACE_CODE ||
                a.LOCATION_DESCRIPTION ||
                "DC Camera",
              description: a.LOCATION_DESCRIPTION || "",
              lat,
              lng,
              speedLimit: a.SPEED_LIMIT,
              activeStatus: a.ACTIVE_STATUS || "",
              cameraStatus: a.CAMERA_STATUS || "",
              mobility: a.DEVICE_MOBILITY || "",
              ward: a.WARD || "",
            };
          })
          .filter(
            (camera) =>
              Number.isFinite(camera.lat) && Number.isFinite(camera.lng)
          )
          .filter((camera) => {
            const statusText =
              `${camera.activeStatus} ${camera.cameraStatus}`.toLowerCase();
            return !(
              statusText.includes("inactive") ||
              statusText.includes("decommission")
            );
          });

        setCameraData(mapped);
        setStatus(
          `Loaded ${mapped.length} Washington, DC traffic cameras. Use GPS or start alerts anytime.`
        );
      } catch (error) {
        console.error(error);
        setCameraError(
          "Could not load the Washington, DC traffic camera database."
        );
        setStatus("Could not load traffic camera data.");
      }
    }

    loadCameras();

    return () => {
      if (
        !isNativeApp() &&
        watchIdRef.current !== null &&
        navigator.geolocation
      ) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
      if (isNativeApp() && nativeWatchCallbackIdRef.current) {
        Geolocation.clearWatch({ id: nativeWatchCallbackIdRef.current }).catch(
          () => {}
        );
      }
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  useEffect(() => {
    if (!searchQuery || searchQuery.trim().length < 2) {
      setSearchResults([]);
      setRouteError("");
      setSearching(false);
      return;
    }

    const timeout = setTimeout(async () => {
      try {
        setSearching(true);
        setRouteError("");
        const results = await searchPlaces(searchQuery);
        setSearchResults(results);
      } catch (error) {
        console.error(error);
        setRouteError(error?.message || "Could not search places.");
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);

    return () => clearTimeout(timeout);
  }, [searchQuery]);

  const cameras = useMemo(() => {
    const filtered = cameraData.filter((camera) => {
      if (camera.type === "speed") return showSpeed;
      if (camera.type === "red_light") return showRedLight;
      return showOther;
    });

    if (!position) {
      return filtered.map((camera) => ({
        ...camera,
        distanceMeters: Infinity,
        bearingToCamera: null,
        ahead: true,
        nearRoute: false,
      }));
    }

    const userHeading = getHeadingDegrees(position.coords);

    return filtered
      .map((camera) => {
        const distanceMeters = distanceInMeters(
          position.coords.latitude,
          position.coords.longitude,
          camera.lat,
          camera.lng
        );

        const bearingToCamera = bearingBetweenPoints(
          position.coords.latitude,
          position.coords.longitude,
          camera.lat,
          camera.lng
        );

        const ahead = isLikelyAhead(userHeading, bearingToCamera);

        const nearRoute =
          routeCoords.length >= 2
            ? isCameraNearRoute(camera, routeCoords, 120)
            : false;

        return {
          ...camera,
          distanceMeters,
          bearingToCamera,
          ahead,
          nearRoute,
        };
      })
      .sort((a, b) => {
        if (routeCoords.length >= 2) {
          if (a.nearRoute && !b.nearRoute) return -1;
          if (!a.nearRoute && b.nearRoute) return 1;
        }
        return a.distanceMeters - b.distanceMeters;
      });
  }, [position, cameraData, showSpeed, showRedLight, showOther, routeCoords]);

  useEffect(() => {
    if (!started || !position || cameras.length === 0) return;

    const alertRadiusMeters = alertRadiusFeet / 3.28084;
    const currentInsideRadius = {};

    cameras.forEach((camera) => {
      if (
        Number.isFinite(camera.distanceMeters) &&
        camera.distanceMeters <= alertRadiusMeters &&
        camera.ahead
      ) {
        currentInsideRadius[camera.id] = true;
      }
    });

    Object.keys(insideRadiusIdsRef.current).forEach((id) => {
      if (!currentInsideRadius[id]) {
        delete insideRadiusIdsRef.current[id];
      }
    });

    let candidates = cameras.filter((camera) => {
      if (!Number.isFinite(camera.distanceMeters)) return false;
      if (camera.distanceMeters > alertRadiusMeters) return false;
      if (!camera.ahead) return false;
      return true;
    });

    if (routeCoords.length >= 2) {
      const nearRouteCandidates = candidates.filter(
        (camera) => camera.nearRoute
      );
      if (nearRouteCandidates.length > 0) {
        candidates = nearRouteCandidates;
      }
    }

    if (candidates.length === 0) {
      setStatus(
        isNavigating
          ? rerouting
            ? "Rebuilding route..."
            : "Voice navigation and traffic camera alerts are active."
          : "Traffic camera alerts are active. No immediate alerts right now."
      );
      return;
    }

    const selected = [candidates[0]];
    const newHistoryEntries = [];
    let didSpeak = false;

    selected.forEach((camera, index) => {
      const alreadyInside = !!insideRadiusIdsRef.current[camera.id];
      const alreadySpoken = !!spokenCameraIdsRef.current[camera.id];

      if (!alreadyInside && !alreadySpoken) {
        const text = getCameraAlertText(
          camera,
          metersToFeet(camera.distanceMeters)
        );

        spokenCameraIdsRef.current[camera.id] = true;
        insideRadiusIdsRef.current[camera.id] = true;

        newHistoryEntries.push({
          id: `${camera.id}-${Date.now()}-${index}`,
          text,
          time: new Date().toLocaleTimeString(),
        });

        if (voiceEnabled) {
          setTimeout(() => {
            speakText(text);
          }, 300 * index);
        }

        fireLocalNotification(
          "NoTicket DC",
          text,
          Number(String(Date.now() + index).slice(-8))
        );
        didSpeak = true;
      } else if (!alreadyInside) {
        insideRadiusIdsRef.current[camera.id] = true;
      }
    });

    if (newHistoryEntries.length > 0) {
      setAlertHistory((prev) => [...newHistoryEntries, ...prev].slice(0, 10));
      setLastAlert(newHistoryEntries[0].text);
    }

    if (didSpeak) {
      setStatus(
        routeCoords.length >= 2
          ? "Traffic camera alerts are active along your route."
          : "Traffic camera alerts are active near your current location."
      );
    } else {
      setStatus(
        isNavigating
          ? rerouting
            ? "Rebuilding route..."
            : "Voice navigation and traffic camera alerts are active."
          : "Traffic camera alerts are active. Monitoring nearby cameras."
      );
    }
  }, [
    started,
    position,
    cameras,
    voiceEnabled,
    alertRadiusFeet,
    routeCoords,
    isNavigating,
    rerouting,
  ]);

  async function rebuildRouteFromCurrentPosition(speakReroute = true) {
    if (!destination || !position?.coords || rerouting) return;

    const now = Date.now();
    if (now - lastRerouteAtRef.current < 7000) return;

    lastRerouteAtRef.current = now;
    setRerouting(true);

    try {
      if (voiceEnabled && speakReroute) {
        speakText("Recalculating route.");
      }

      const route = await getRoute(
        position.coords.latitude,
        position.coords.longitude,
        destination.lat,
        destination.lng
      );

      setRouteCoords(route.geometry.map(([lng, lat]) => [lat, lng]));
      setRouteInfo({
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
      });
      setRouteSteps(route.steps || []);
      setAlternativeRoutes(route.alternatives || []);
      setNavStepIndex(0);

      spokenEarlyStepRef.current = new Set();
      spokenMainStepRef.current = new Set();
      arrivalSpokenRef.current = false;
      navStartedSpokenRef.current = false;

      setStatus("Route updated.");
      if (voiceEnabled) {
        setTimeout(() => {
          const first = route.steps?.[0];
          if (first) {
            speakText(getSpokenInstruction(first, "early"));
            navStartedSpokenRef.current = true;
          }
        }, 800);
      }
    } catch (error) {
      console.error("Reroute error:", error);
      setRouteError(error?.message || "Could not rebuild route.");
    } finally {
      setRerouting(false);
    }
  }

  useEffect(() => {
    if (!isNavigating || !position || !destination || routeSteps.length === 0) {
      return;
    }

    const userLat = position.coords.latitude;
    const userLng = position.coords.longitude;
    const userSpeedMps =
      typeof position.coords.speed === "number" && position.coords.speed > 0
        ? position.coords.speed
        : 0;
    const userSpeedMph = userSpeedMps * 2.23694;

    const destinationDistance = distanceInMeters(
      userLat,
      userLng,
      destination.lat,
      destination.lng
    );

    if (destinationDistance <= 35 && !arrivalSpokenRef.current) {
      arrivalSpokenRef.current = true;
      if (voiceEnabled) {
        speakText("You have arrived at your destination.");
      }
      setIsNavigating(false);
      setStatus("Navigation complete. You have arrived.");
      return;
    }

    const offRouteDistance = distanceToRouteMeters(
      userLat,
      userLng,
      routeCoords
    );
    const offRouteThreshold = userSpeedMph >= 35 ? 90 : 60;

    if (offRouteDistance > offRouteThreshold) {
      rebuildRouteFromCurrentPosition(true);
      return;
    }

    const nextIndex = (() => {
      let bestIndex = navStepIndex;
      let bestDistance = Infinity;

      const maxLookAhead = Math.min(routeSteps.length - 1, navStepIndex + 3);
      for (let i = navStepIndex; i <= maxLookAhead; i++) {
        const d = getStepProgressDistance(routeSteps[i], userLat, userLng);
        if (d < bestDistance) {
          bestDistance = d;
          bestIndex = i;
        }
      }
      return bestIndex;
    })();

    if (nextIndex !== navStepIndex) {
      setNavStepIndex(nextIndex);
    }

    const currentStep = routeSteps[nextIndex];
    if (!currentStep) return;

    const distanceToCurrentStep = getStepProgressDistance(
      currentStep,
      userLat,
      userLng
    );

    let earlyWarningFeet = 250;
    if (userSpeedMph >= 50) earlyWarningFeet = 1000;
    else if (userSpeedMph >= 35) earlyWarningFeet = 700;
    else if (userSpeedMph >= 20) earlyWarningFeet = 400;

    const earlyWarningMeters = earlyWarningFeet / 3.28084;
    const immediateMeters = 30;
    const stepKey = `step-${nextIndex}`;

    if (
      !spokenEarlyStepRef.current.has(stepKey) &&
      distanceToCurrentStep <= earlyWarningMeters &&
      distanceToCurrentStep > immediateMeters
    ) {
      spokenEarlyStepRef.current.add(stepKey);
      const text = getSpokenInstruction(currentStep, "early");
      setStatus(text);
      if (voiceEnabled) speakText(text);
      return;
    }

    if (
      !spokenMainStepRef.current.has(stepKey) &&
      distanceToCurrentStep <= immediateMeters
    ) {
      spokenMainStepRef.current.add(stepKey);
      const text = getSpokenInstruction(currentStep, "main");
      setStatus(text);
      if (voiceEnabled) speakText(text);

      if (nextIndex < routeSteps.length - 1) {
        setTimeout(() => {
          setNavStepIndex((prev) =>
            prev < routeSteps.length - 1 ? prev + 1 : prev
          );
        }, 1200);
      }
      return;
    }

    if (!navStartedSpokenRef.current && routeSteps[0]) {
      navStartedSpokenRef.current = true;
      const text = getSpokenInstruction(routeSteps[0], "early");
      setStatus(`Navigation started. ${text}`);
      if (voiceEnabled) speakText(`Navigation started. ${text}`);
    }
  }, [
    isNavigating,
    position,
    destination,
    routeCoords,
    routeSteps,
    navStepIndex,
    voiceEnabled,
  ]);

  async function startDriveMode() {
    try {
      setLocationError("");
      setStarted(true);
      setStatus("Requesting location access for traffic camera alerts...");
      spokenCameraIdsRef.current = {};
      insideRadiusIdsRef.current = {};

      if (isNativeApp()) {
        const locationGranted = await requestLocationPermission();
        const notificationGranted = await requestNotificationPermission();

        if (!locationGranted) {
          setLocationError(
            "Location permission denied. Please allow location access."
          );
          setStatus("Location permission denied.");
          setStarted(false);
          return;
        }

        if (!notificationGranted) {
          setStatus("Location active. Notifications are not allowed yet.");
        }

        if (nativeWatchCallbackIdRef.current) {
          await Geolocation.clearWatch({
            id: nativeWatchCallbackIdRef.current,
          }).catch(() => {});
        }

        nativeWatchCallbackIdRef.current = await Geolocation.watchPosition(
          {
            enableHighAccuracy: true,
            timeout: 30000,
            maximumAge: 3000,
          },
          (pos, err) => {
            if (err) {
              setLocationError(err.message || "Unable to get your location.");
              setStatus("Unable to get your location.");
              return;
            }

            if (pos) {
              setPosition(pos);
              setPermissionReady(true);
              setLocationError("");
              setStatus(
                isNavigating
                  ? rerouting
                    ? "Rebuilding route..."
                    : "Voice navigation and traffic camera alerts are active."
                  : "Traffic camera alerts are active. Tracking location live."
              );
            }
          }
        );

        return;
      }

      if (!navigator.geolocation) {
        setLocationError(
          "Geolocation is not supported on this device/browser."
        );
        setStarted(false);
        return;
      }

      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }

      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          setPosition(pos);
          setPermissionReady(true);
          setLocationError("");
          setStatus(
            isNavigating
              ? rerouting
                ? "Rebuilding route..."
                : "Voice navigation and traffic camera alerts are active."
              : "Traffic camera alerts are active. Tracking location live."
          );
        },
        (error) => {
          let message = "Unable to get your location.";

          if (error.code === 1) {
            message =
              "Location permission denied. Please allow location access.";
          } else if (error.code === 2) {
            message =
              "Location unavailable. Try going outside or checking your GPS.";
          } else if (error.code === 3) {
            message =
              "Location request timed out. Try again outside or wait a few seconds.";
          }

          setLocationError(message);
          setStatus(message);
          setStarted(false);
        },
        {
          enableHighAccuracy: true,
          maximumAge: 3000,
          timeout: 30000,
        }
      );
    } catch (error) {
      console.error(error);
      setLocationError("Could not start traffic camera alerts.");
      setStatus("Could not start traffic camera alerts.");
      setStarted(false);
    }
  }

  async function stopDriveMode() {
    if (
      !isNativeApp() &&
      watchIdRef.current !== null &&
      navigator.geolocation
    ) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }

    if (isNativeApp() && nativeWatchCallbackIdRef.current) {
      await Geolocation.clearWatch({
        id: nativeWatchCallbackIdRef.current,
      }).catch(() => {});
      nativeWatchCallbackIdRef.current = null;
    }

    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    setIsNavigating(false);
    setNavStepIndex(0);
    setRerouting(false);
    setStarted(false);
    setStatus("Traffic camera alerts stopped.");
    insideRadiusIdsRef.current = {};
    spokenEarlyStepRef.current = new Set();
    spokenMainStepRef.current = new Set();
    arrivalSpokenRef.current = false;
    navStartedSpokenRef.current = false;
  }

  async function handleSearch() {
    try {
      setSearching(true);
      setRouteError("");
      const results = await searchPlaces(searchQuery);
      setSearchResults(results);
      if (results.length === 0) {
        setRouteError(
          "No destinations found in Washington, DC, Maryland, or Virginia."
        );
      }
    } catch (error) {
      console.error(error);
      setRouteError(error?.message || "Could not search places.");
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function selectDestination(place) {
    try {
      setRouteLoading(true);
      setRouteError("");
      setRouteCoords([]);
      setRouteInfo(null);
      setRouteSteps([]);
      setAlternativeRoutes([]);
      setDestination(place);
      setSearchQuery(place.name);
      setSearchResults([]);
      setIsNavigating(false);
      setNavStepIndex(0);
      setRerouting(false);

      spokenEarlyStepRef.current = new Set();
      spokenMainStepRef.current = new Set();
      arrivalSpokenRef.current = false;
      navStartedSpokenRef.current = false;

      if (!Number.isFinite(place?.lat) || !Number.isFinite(place?.lng)) {
        throw new Error("Destination coordinates are invalid.");
      }

      const updatedRecents = [
        place,
        ...recentSearches.filter(
          (item) => String(item.id) !== String(place.id)
        ),
      ].slice(0, 6);

      setRecentSearches(updatedRecents);
      saveRecentSearches(updatedRecents);

      let currentPos = position;

      if (
        !currentPos?.coords ||
        !Number.isFinite(currentPos.coords.latitude) ||
        !Number.isFinite(currentPos.coords.longitude)
      ) {
        const freshPos = await getFreshPosition();
        currentPos = freshPos;
        setPosition(freshPos);
        setPermissionReady(true);
      }

      const route = await getRoute(
        currentPos.coords.latitude,
        currentPos.coords.longitude,
        place.lat,
        place.lng
      );

      setRouteCoords(route.geometry.map(([lng, lat]) => [lat, lng]));
      setRouteInfo({
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
      });
      setRouteSteps(route.steps || []);
      setAlternativeRoutes(route.alternatives || []);
      setNavStepIndex(0);
      setStatus("Route ready. Voice navigation is ready to start.");
    } catch (error) {
      console.error("Route build error:", error);
      setRouteError(error?.message || "Could not build route.");
      setRouteCoords([]);
      setRouteInfo(null);
      setRouteSteps([]);
      setAlternativeRoutes([]);
    } finally {
      setRouteLoading(false);
    }
  }

  async function useCurrentLocationAsSearch() {
    try {
      let currentPos = position;

      if (!currentPos?.coords) {
        const freshPos = await getFreshPosition();
        currentPos = freshPos;
        setPosition(freshPos);
        setPermissionReady(true);
      }

      const place = {
        id: "current-location",
        name: "Current Location",
        subtitle: "DMV Area",
        full: "Current Location",
        lat: currentPos.coords.latitude,
        lng: currentPos.coords.longitude,
      };

      setDestination(place);
      setSearchQuery("Current Location");
      setSearchResults([]);
    } catch (error) {
      console.error(error);
      setRouteError("Current location is not ready yet.");
    }
  }

  function startNavigation() {
    if (!routeSteps.length) return;

    setIsNavigating(true);
    setNavStepIndex(0);
    setRerouting(false);
    spokenEarlyStepRef.current = new Set();
    spokenMainStepRef.current = new Set();
    arrivalSpokenRef.current = false;
    navStartedSpokenRef.current = false;

    const firstStep = routeSteps[0];
    if (firstStep) {
      const spoken = getSpokenInstruction(firstStep, "early");
      setStatus(`Navigation started. ${spoken}`);

      if (voiceEnabled) {
        speakText(`Navigation started. ${spoken}`);
      }
      navStartedSpokenRef.current = true;
    } else {
      setStatus("Navigation started.");
    }
  }

  function stopNavigation() {
    setIsNavigating(false);
    setNavStepIndex(0);
    setRerouting(false);
    spokenEarlyStepRef.current = new Set();
    spokenMainStepRef.current = new Set();
    arrivalSpokenRef.current = false;
    navStartedSpokenRef.current = false;

    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    setStatus("Navigation stopped.");
  }

  function clearRoute() {
    setDestination(null);
    setRouteCoords([]);
    setRouteInfo(null);
    setRouteSteps([]);
    setAlternativeRoutes([]);
    setSearchResults([]);
    setRouteError("");
    setSearchQuery("");
    setIsNavigating(false);
    setNavStepIndex(0);
    setRerouting(false);

    spokenEarlyStepRef.current = new Set();
    spokenMainStepRef.current = new Set();
    arrivalSpokenRef.current = false;
    navStartedSpokenRef.current = false;

    setStatus(
      started
        ? "Traffic camera alerts are active. Route cleared."
        : "Route cleared."
    );
  }

  const nearest = cameras[0];
  const camerasAhead = cameras.filter((camera) => camera.ahead).length;
  const camerasNearRoute = cameras.filter((camera) => camera.nearRoute).length;
  const userHeading = position
    ? getCardinalDirection(getHeadingDegrees(position.coords))
    : "--";

  const mapCenter = position?.coords
    ? [position.coords.latitude, position.coords.longitude]
    : destination
    ? [destination.lat, destination.lng]
    : [38.9072, -77.0369];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#111",
        color: "white",
        fontFamily: "Arial, sans-serif",
        padding: "20px",
      }}
    >
      <div style={{ maxWidth: "940px", margin: "0 auto" }}>
        <h1 style={{ fontSize: "40px", marginBottom: "10px" }}>No Ticket DC</h1>
        <p style={{ color: "#ccc", fontSize: "18px", marginTop: 0 }}>
          Traffic Enforcement Camera Alert and GPS
        </p>

        <div
          style={{
            background: "#1b1b1b",
            border: "1px solid #333",
            borderRadius: "16px",
            padding: "20px",
            marginTop: "20px",
          }}
        >
          <h2 style={{ marginTop: 0 }}>GPS Navigation</h2>
          <p style={{ color: "#bbb", lineHeight: 1.6 }}>
            Traffic camera alerts and GPS in the DMV area. Voice guidance speaks
            turn-by-turn directions and reroutes if the driver goes off route.
          </p>

          <div
            style={{
              marginTop: "16px",
              display: "flex",
              gap: "12px",
              flexWrap: "wrap",
            }}
          >
            {!started ? (
              <button
                onClick={startDriveMode}
                style={{
                  background: "red",
                  color: "white",
                  border: "none",
                  padding: "16px 28px",
                  borderRadius: "12px",
                  fontSize: "18px",
                  fontWeight: "bold",
                  cursor: "pointer",
                }}
              >
                Start Traffic Camera Alerts
              </button>
            ) : (
              <button
                onClick={stopDriveMode}
                style={{
                  background: "#444",
                  color: "white",
                  border: "none",
                  padding: "16px 28px",
                  borderRadius: "12px",
                  fontSize: "18px",
                  fontWeight: "bold",
                  cursor: "pointer",
                }}
              >
                Stop Traffic Camera Alerts
              </button>
            )}

            <button
              onClick={() => {
                const text =
                  "Speed Camera Ahead in 200 feet. Please Follow Posted Speed Limit";
                setLastAlert(text);
                if (voiceEnabled) speakText(text);
                fireLocalNotification(
                  "NoTicket DC",
                  text,
                  Number(String(Date.now()).slice(-8))
                );
              }}
              style={{
                background: "#222",
                color: "white",
                border: "1px solid #555",
                padding: "16px 24px",
                borderRadius: "12px",
                fontSize: "16px",
                cursor: "pointer",
              }}
            >
              Test Traffic Camera Alerts
            </button>
          </div>

          <div
            style={{
              display: "flex",
              gap: "10px",
              flexWrap: "wrap",
              marginTop: "20px",
            }}
          >
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search DMV address or place"
              style={{
                flex: 1,
                minWidth: "240px",
                padding: "14px",
                borderRadius: "10px",
                border: "1px solid #555",
                background: "#111",
                color: "white",
              }}
            />

            <button
              onClick={handleSearch}
              style={{
                background: "#2563eb",
                color: "white",
                border: "none",
                padding: "14px 18px",
                borderRadius: "10px",
                cursor: "pointer",
              }}
            >
              Search
            </button>

            <button
              onClick={useCurrentLocationAsSearch}
              style={{
                background: "#0f766e",
                color: "white",
                border: "none",
                padding: "14px 18px",
                borderRadius: "10px",
                cursor: "pointer",
              }}
            >
              Use Current Location
            </button>

            <button
              onClick={clearRoute}
              style={{
                background: "#444",
                color: "white",
                border: "none",
                padding: "14px 18px",
                borderRadius: "10px",
                cursor: "pointer",
              }}
            >
              Clear Route
            </button>
          </div>

          {searching && (
            <p style={{ marginTop: "12px", color: "#ccc" }}>
              Searching the DMV area...
            </p>
          )}

          {searchResults.length > 0 && (
            <div style={{ marginTop: "14px" }}>
              {searchResults.map((place) => (
                <div
                  key={place.id}
                  onClick={() => selectDestination(place)}
                  style={{
                    background: "#111",
                    border: "1px solid #333",
                    borderRadius: "12px",
                    padding: "14px",
                    marginTop: "10px",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontWeight: "bold" }}>{place.name}</div>
                  <div
                    style={{
                      color: "#aaa",
                      marginTop: "4px",
                      fontSize: "14px",
                    }}
                  >
                    {place.subtitle || place.full}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!searchQuery && recentSearches.length > 0 && (
            <div style={{ marginTop: "18px" }}>
              <div style={{ fontWeight: "bold", marginBottom: "10px" }}>
                Recent Searches
              </div>
              {recentSearches.map((place) => (
                <div
                  key={`recent-${place.id}`}
                  onClick={() => selectDestination(place)}
                  style={{
                    background: "#111",
                    border: "1px solid #333",
                    borderRadius: "12px",
                    padding: "14px",
                    marginTop: "10px",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontWeight: "bold" }}>{place.name}</div>
                  <div
                    style={{
                      color: "#aaa",
                      marginTop: "4px",
                      fontSize: "14px",
                    }}
                  >
                    {place.subtitle || place.full}
                  </div>
                </div>
              ))}
            </div>
          )}

          {routeLoading && (
            <p style={{ marginTop: "12px" }}>Building route...</p>
          )}

          {routeError && (
            <p style={{ marginTop: "12px", color: "#fca5a5" }}>{routeError}</p>
          )}

          {routeInfo && (
            <div style={{ marginTop: "14px", color: "#ddd", lineHeight: 1.8 }}>
              <div>
                <strong>Destination:</strong> {destination?.name || "--"}
              </div>
              <div>
                <strong>Route distance:</strong>{" "}
                {formatDistance(routeInfo.distanceMeters)}
              </div>
              <div>
                <strong>Estimated drive time:</strong>{" "}
                {formatDuration(routeInfo.durationSeconds)}
              </div>
              <div>
                <strong>Washington, DC cameras near route:</strong>{" "}
                {camerasNearRoute}
              </div>

              <div
                style={{
                  marginTop: "14px",
                  display: "flex",
                  gap: "10px",
                  flexWrap: "wrap",
                }}
              >
                {!isNavigating ? (
                  <button
                    onClick={startNavigation}
                    style={{
                      background: "#16a34a",
                      color: "white",
                      border: "none",
                      padding: "14px 18px",
                      borderRadius: "10px",
                      cursor: "pointer",
                      fontWeight: "bold",
                    }}
                  >
                    Start Navigation
                  </button>
                ) : (
                  <button
                    onClick={stopNavigation}
                    style={{
                      background: "#444",
                      color: "white",
                      border: "none",
                      padding: "14px 18px",
                      borderRadius: "10px",
                      cursor: "pointer",
                      fontWeight: "bold",
                    }}
                  >
                    Stop Navigation
                  </button>
                )}

                {isNavigating && (
                  <div
                    style={{
                      background: "#111",
                      border: "1px solid #333",
                      borderRadius: "10px",
                      padding: "12px 14px",
                      color: "#ddd",
                    }}
                  >
                    {rerouting
                      ? "Recalculating route..."
                      : "Voice navigation active"}
                  </div>
                )}
              </div>

              {alternativeRoutes.length > 0 && (
                <div style={{ marginTop: "14px" }}>
                  <div style={{ fontWeight: "bold", marginBottom: "8px" }}>
                    Alternate routes available
                  </div>
                  {alternativeRoutes.map((route) => (
                    <div
                      key={route.id}
                      style={{
                        background: "#111",
                        border: "1px solid #333",
                        borderRadius: "10px",
                        padding: "10px 12px",
                        marginTop: "8px",
                        color: "#bbb",
                      }}
                    >
                      {formatDistance(route.distanceMeters)} •{" "}
                      {formatDuration(route.durationSeconds)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div
            style={{
              marginTop: "18px",
              borderRadius: "14px",
              overflow: "hidden",
              border: "1px solid #333",
            }}
          >
            <MapContainer
              key={`${mapCenter[0]}-${mapCenter[1]}-${routeCoords.length}`}
              center={mapCenter}
              zoom={11}
              scrollWheelZoom={true}
              style={{ height: "460px", width: "100%" }}
            >
              <RecenterMap center={mapCenter} zoom={11} />

              <TileLayer
                attribution="&copy; OpenStreetMap contributors"
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />

              {position?.coords && (
                <CircleMarker
                  center={[position.coords.latitude, position.coords.longitude]}
                  radius={10}
                  pathOptions={{
                    color: "#22c55e",
                    fillColor: "#22c55e",
                    fillOpacity: 0.9,
                  }}
                >
                  <Popup>Your current location</Popup>
                </CircleMarker>
              )}

              {destination && (
                <CircleMarker
                  center={[destination.lat, destination.lng]}
                  radius={10}
                  pathOptions={{
                    color: "#2563eb",
                    fillColor: "#2563eb",
                    fillOpacity: 0.9,
                  }}
                >
                  <Popup>{destination.name}</Popup>
                </CircleMarker>
              )}

              {routeCoords.length > 1 && (
                <Polyline
                  positions={routeCoords}
                  pathOptions={{ color: "#38bdf8", weight: 5 }}
                />
              )}

              {cameras.slice(0, 200).map((camera) => (
                <CircleMarker
                  key={camera.id}
                  center={[camera.lat, camera.lng]}
                  radius={camera.nearRoute ? 8 : 5}
                  pathOptions={{
                    color: getCameraColor(camera),
                    fillColor: getCameraColor(camera),
                    fillOpacity: camera.nearRoute ? 0.95 : 0.65,
                  }}
                >
                  <Popup>
                    <div style={{ minWidth: "220px" }}>
                      <div style={{ fontWeight: "bold", marginBottom: "6px" }}>
                        {camera.typeLabel || "Camera"}
                      </div>
                      <div>{camera.name}</div>
                      <div style={{ marginTop: "4px", color: "#444" }}>
                        {camera.description}
                      </div>
                      <div style={{ marginTop: "8px" }}>
                        Distance: {formatDistance(camera.distanceMeters)}
                      </div>
                      {camera.speedLimit ? (
                        <div style={{ marginTop: "4px" }}>
                          Speed limit: {camera.speedLimit} mph
                        </div>
                      ) : null}
                      <div style={{ marginTop: "4px" }}>
                        {camera.nearRoute
                          ? "Near active route"
                          : "Not on active route"}
                      </div>
                      <div style={{ marginTop: "4px" }}>
                        {camera.ahead ? "Ahead of driver" : "Other direction"}
                      </div>
                    </div>
                  </Popup>
                </CircleMarker>
              ))}
            </MapContainer>
          </div>
        </div>

        <div
          style={{
            background: "#1b1b1b",
            border: "1px solid #333",
            borderRadius: "16px",
            padding: "20px",
            marginTop: "20px",
          }}
        >
          <h2>Status</h2>
          <p>{status}</p>
          <p>
            <strong>Platform:</strong>{" "}
            {isNativeApp() ? "Native mobile app" : "Web browser"}
          </p>
          <p>
            <strong>Permissions ready:</strong>{" "}
            {permissionReady ? "Yes" : "Not yet"}
          </p>
          <p>
            <strong>Washington, DC cameras loaded:</strong> {cameraData.length}
          </p>
          <p>
            <strong>Latest alert:</strong> {lastAlert}
          </p>
          <p>
            <strong>Nearest camera:</strong>{" "}
            {nearest
              ? `${nearest.typeLabel || "Camera"} (${formatDistance(
                  nearest.distanceMeters
                )})`
              : "--"}
          </p>
          <p>
            <strong>Heading:</strong> {userHeading}
          </p>
          <p>
            <strong>Cameras ahead:</strong> {camerasAhead}
          </p>
          <p>
            <strong>Washington, DC cameras near active route:</strong>{" "}
            {camerasNearRoute}
          </p>

          <div style={{ marginTop: "15px" }}>
            <label>
              <input
                type="checkbox"
                checked={voiceEnabled}
                onChange={(e) => setVoiceEnabled(e.target.checked)}
                style={{ marginRight: "8px" }}
              />
              Voice alerts enabled
            </label>
          </div>

          <div style={{ marginTop: "12px" }}>
            <label style={{ display: "block", marginBottom: "8px" }}>
              <input
                type="checkbox"
                checked={showSpeed}
                onChange={(e) => setShowSpeed(e.target.checked)}
                style={{ marginRight: "8px" }}
              />
              Speed cameras
            </label>

            <label style={{ display: "block", marginBottom: "8px" }}>
              <input
                type="checkbox"
                checked={showRedLight}
                onChange={(e) => setShowRedLight(e.target.checked)}
                style={{ marginRight: "8px" }}
              />
              Red light cameras
            </label>

            <label style={{ display: "block", marginBottom: "8px" }}>
              <input
                type="checkbox"
                checked={showOther}
                onChange={(e) => setShowOther(e.target.checked)}
                style={{ marginRight: "8px" }}
              />
              Other enforcement types
            </label>
          </div>

          <div style={{ marginTop: "15px" }}>
            <label>
              Alert radius: {alertRadiusFeet} feet
              <br />
              <input
                type="range"
                min="50"
                max="2000"
                step="25"
                value={alertRadiusFeet}
                onChange={(e) => setAlertRadiusFeet(Number(e.target.value))}
                style={{ width: "100%", marginTop: "10px" }}
              />
            </label>
          </div>

          {locationError && (
            <div
              style={{
                marginTop: "15px",
                background: "#402000",
                color: "#ffd27f",
                padding: "12px",
                borderRadius: "10px",
              }}
            >
              {locationError}
            </div>
          )}

          {cameraError && (
            <div
              style={{
                marginTop: "15px",
                background: "#401414",
                color: "#ffb3b3",
                padding: "12px",
                borderRadius: "10px",
              }}
            >
              {cameraError}
            </div>
          )}
        </div>

        <div style={{ marginTop: "24px" }}>
          <h2>Recent Alert History</h2>
          {alertHistory.length === 0 ? (
            <div
              style={{
                background: "#1b1b1b",
                border: "1px solid #333",
                borderRadius: "14px",
                padding: "16px",
                marginTop: "12px",
              }}
            >
              No alerts triggered yet.
            </div>
          ) : (
            alertHistory.map((entry) => (
              <div
                key={entry.id}
                style={{
                  background: "#1b1b1b",
                  border: "1px solid #333",
                  borderRadius: "14px",
                  padding: "16px",
                  marginTop: "12px",
                }}
              >
                <div style={{ fontWeight: "bold" }}>{entry.time}</div>
                <div style={{ marginTop: "6px", color: "#ddd" }}>
                  {entry.text}
                </div>
              </div>
            ))
          )}
        </div>

        <div style={{ marginTop: "24px" }}>
          <h2>Nearest Cameras</h2>
          {cameras.slice(0, 20).map((camera) => (
            <div
              key={camera.id}
              style={{
                background: "#1b1b1b",
                border: "1px solid #333",
                borderRadius: "14px",
                padding: "16px",
                marginTop: "12px",
              }}
            >
              <div style={{ fontWeight: "bold", fontSize: "18px" }}>
                {camera.typeLabel || "Camera"}
                {camera.nearRoute ? " • Near Route" : ""}
                {camera.ahead ? " • Ahead" : " • Other Direction"}
              </div>
              <div style={{ marginTop: "6px" }}>{camera.name}</div>
              <div style={{ color: "#bbb", marginTop: "4px" }}>
                {camera.description}
              </div>
              <div style={{ marginTop: "8px" }}>
                Distance: {formatDistance(camera.distanceMeters)}
              </div>
              {camera.speedLimit ? (
                <div style={{ marginTop: "4px", color: "#aaa" }}>
                  Speed limit: {camera.speedLimit} mph
                </div>
              ) : null}
              <div
                style={{ marginTop: "4px", color: "#888", fontSize: "14px" }}
              >
                Status: {camera.activeStatus || "--"} /{" "}
                {camera.cameraStatus || "--"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
