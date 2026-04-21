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

function getAlertText(camera) {
  if (camera.type === "speed") {
    return "Speed camera ahead, please follow posted speed limit.";
  }

  if (camera.type === "red_light") {
    return "Red light camera ahead.";
  }

  if (camera.type === "stop_sign") {
    return "Stop sign camera ahead.";
  }

  if (camera.type === "bus_lane" || camera.type === "truck") {
    return "Traffic enforcement camera ahead.";
  }

  return "Traffic camera ahead.";
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

function toBool(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  return value === "true";
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function speakText(text) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
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

async function searchPlaces(query) {
  if (!query || query.trim().length < 2) return [];

  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&countrycodes=us&viewbox=-77.65,39.75,-76.85,37.85&bounded=1&q=" +
    encodeURIComponent(query.trim());

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error("Place search failed.");
  }

  const data = await response.json();

  return data.map((item) => {
    const parts = String(item.display_name || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    return {
      id: item.place_id,
      name: parts[0] || item.display_name,
      subtitle: parts.slice(1, 5).join(", "),
      full: item.display_name,
      lat: Number(item.lat),
      lng: Number(item.lon),
    };
  });
}

async function getRoute(originLat, originLng, destLat, destLng) {
  const coordinates = `${originLng},${originLat};${destLng},${destLat}`;
  const url =
    `https://router.project-osrm.org/route/v1/driving/${coordinates}` +
    `?overview=full&geometries=geojson&steps=true`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Route request failed.");
  }

  const data = await response.json();

  if (!data.routes || !data.routes.length) {
    throw new Error("No route found.");
  }

  const route = data.routes[0];
  const legs = route.legs || [];
  const steps = legs.flatMap((leg) => leg.steps || []);

  return {
    distanceMeters: route.distance,
    durationSeconds: route.duration,
    geometry: route.geometry?.coordinates || [],
    steps,
  };
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

    if (distance <= thresholdMeters) {
      return true;
    }
  }

  return false;
}

function buildStepInstruction(step) {
  const type = step?.maneuver?.type || "continue";
  const modifier = step?.maneuver?.modifier || "";
  const name = step?.name || "";

  if (type === "depart") return `Start on ${name || "the road"}`;
  if (type === "arrive") return "You have arrived at your destination";
  if (type === "roundabout") {
    return `Enter roundabout${name ? ` toward ${name}` : ""}`;
  }
  if (type === "turn") {
    return `Turn ${modifier || "ahead"}${name ? ` onto ${name}` : ""}`;
  }
  if (type === "merge") {
    return `Merge${name ? ` onto ${name}` : ""}`;
  }
  if (type === "fork") {
    return `Keep ${modifier || "forward"}${name ? ` toward ${name}` : ""}`;
  }
  if (type === "end of road") {
    return `At end of road, turn ${modifier || "ahead"}${
      name ? ` onto ${name}` : ""
    }`;
  }
  if (type === "new name") {
    return `Continue onto ${name || "the road"}`;
  }
  if (type === "on ramp") {
    return `Take ramp${name ? ` to ${name}` : ""}`;
  }
  if (type === "off ramp") {
    return `Take exit${name ? ` toward ${name}` : ""}`;
  }

  return name ? `Continue on ${name}` : "Continue straight";
}

function getCameraColor(camera) {
  if (camera.type === "speed") return "#ef4444";
  if (camera.type === "red_light") return "#f59e0b";
  if (camera.type === "stop_sign") return "#8b5cf6";
  return "#3b82f6";
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

  const watchIdRef = useRef(null);
  const spokenCameraIdsRef = useRef({});
  const insideRadiusIdsRef = useRef({});
  const nativeWatchCallbackIdRef = useRef(null);
  const lastSpokenNavStepRef = useRef(-1);

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
        setRouteError("Could not search places.");
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
        ahead: true,
        nearRoute: false,
      }));
    }

    return filtered
      .map((camera) => {
        const distanceMeters = distanceInMeters(
          position.coords.latitude,
          position.coords.longitude,
          camera.lat,
          camera.lng
        );

        const nearRoute =
          routeCoords.length >= 2
            ? isCameraNearRoute(camera, routeCoords, 120)
            : false;

        return {
          ...camera,
          distanceMeters,
          ahead: true,
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
        camera.distanceMeters <= alertRadiusMeters
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
        "Traffic camera alerts are active. No immediate alerts right now."
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
        const text = getAlertText(camera);

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
          }, 600 * index);
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
      setStatus("Traffic camera alerts are active. Monitoring nearby cameras.");
    }
  }, [started, position, cameras, voiceEnabled, alertRadiusFeet, routeCoords]);
  useEffect(() => {
    if (!isNavigating || !position || routeSteps.length === 0) return;

    const currentStep = routeSteps[navStepIndex];
    if (!currentStep) return;

    if (lastSpokenNavStepRef.current !== navStepIndex) {
      const instruction = buildStepInstruction(currentStep);
      if (voiceEnabled) {
        speakText(instruction);
      }
      lastSpokenNavStepRef.current = navStepIndex;
      setStatus(`Navigation active: ${instruction}`);
    }

    const maneuverLocation = currentStep?.maneuver?.location;
    if (!Array.isArray(maneuverLocation) || maneuverLocation.length < 2) return;

    const [stepLng, stepLat] = maneuverLocation;

    if (!Number.isFinite(stepLat) || !Number.isFinite(stepLng)) return;

    const distanceToStep = distanceInMeters(
      position.coords.latitude,
      position.coords.longitude,
      stepLat,
      stepLng
    );

    if (distanceToStep <= 40) {
      if (navStepIndex < routeSteps.length - 1) {
        setNavStepIndex((prev) => prev + 1);
      } else {
        if (voiceEnabled) {
          speakText("You have arrived at your destination.");
        }
        setIsNavigating(false);
        setStatus("Navigation complete. You have arrived.");
      }
    }
  }, [isNavigating, position, routeSteps, navStepIndex, voiceEnabled]);

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
            maximumAge: 10000,
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
                "Traffic camera alerts are active. Tracking location live."
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
            "Traffic camera alerts are active. Tracking location live."
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
          maximumAge: 10000,
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
    lastSpokenNavStepRef.current = -1;
    setStarted(false);
    setStatus("Traffic camera alerts stopped.");
    insideRadiusIdsRef.current = {};
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
      setRouteError("Could not search places.");
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function selectDestination(place) {
    if (!position?.coords) {
      setRouteError(
        "Start traffic camera alerts first so the app can get your current location."
      );
      return;
    }

    try {
      setRouteLoading(true);
      setRouteError("");
      setDestination(place);
      setSearchQuery(place.name);
      setSearchResults([]);
      setIsNavigating(false);
      setNavStepIndex(0);
      lastSpokenNavStepRef.current = -1;

      const updatedRecents = [
        place,
        ...recentSearches.filter(
          (item) => String(item.id) !== String(place.id)
        ),
      ].slice(0, 6);

      setRecentSearches(updatedRecents);
      saveRecentSearches(updatedRecents);

      const route = await getRoute(
        position.coords.latitude,
        position.coords.longitude,
        place.lat,
        place.lng
      );

      setRouteCoords(route.geometry.map(([lng, lat]) => [lat, lng]));
      setRouteInfo({
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
      });
      setRouteSteps(route.steps);
      setNavStepIndex(0);
      lastSpokenNavStepRef.current = -1;
      setStatus(
        "Route ready. Washington, DC traffic camera alerts will follow your active route."
      );
    } catch (error) {
      console.error(error);
      setRouteError("Could not build route.");
      setRouteCoords([]);
      setRouteInfo(null);
      setRouteSteps([]);
    } finally {
      setRouteLoading(false);
    }
  }

  async function useCurrentLocationAsSearch() {
    if (!position?.coords) {
      setRouteError("Current location is not ready yet.");
      return;
    }

    const place = {
      id: "current-location",
      name: "Current Location",
      subtitle: "DMV Area",
      full: "Current Location",
      lat: position.coords.latitude,
      lng: position.coords.longitude,
    };

    setDestination(place);
    setSearchQuery("Current Location");
    setSearchResults([]);
  }
  function startNavigation() {
    if (!routeSteps.length) return;

    setIsNavigating(true);
    setNavStepIndex(0);
    lastSpokenNavStepRef.current = -1;
    setStatus("Navigation started.");
  }

  function stopNavigation() {
    setIsNavigating(false);
    setNavStepIndex(0);
    lastSpokenNavStepRef.current = -1;

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
    setSearchResults([]);
    setRouteError("");
    setSearchQuery("");
    setIsNavigating(false);
    setNavStepIndex(0);
    lastSpokenNavStepRef.current = -1;
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

  const mapCenter = destination
    ? [destination.lat, destination.lng]
    : position?.coords
    ? [position.coords.latitude, position.coords.longitude]
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
            Traffic Camera Alerts and GPS in The DMV Area. Click the Red Button
            to Get Alerted for Red Light, Stop Sign, and Speed Cameras in
            Washington DC.
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
                const text = getAlertText({ type: "speed" });
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
              Test Voice Alert
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

                {routeSteps.length > 0 && (
                  <div
                    style={{
                      background: "#111",
                      border: "1px solid #333",
                      borderRadius: "10px",
                      padding: "12px 14px",
                      color: "#ddd",
                    }}
                  >
                    <strong>Next step:</strong>{" "}
                    {buildStepInstruction(
                      routeSteps[navStepIndex] || routeSteps[0]
                    )}
                  </div>
                )}
              </div>
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
                    </div>
                  </Popup>
                </CircleMarker>
              ))}
            </MapContainer>
          </div>
        </div>

        {routeSteps.length > 0 && (
          <div
            style={{
              background: "#1b1b1b",
              border: "1px solid #333",
              borderRadius: "16px",
              padding: "20px",
              marginTop: "20px",
            }}
          >
            <h2 style={{ marginTop: 0 }}>Directions</h2>
            {routeSteps.slice(0, 12).map((step, index) => (
              <div
                key={`${step.name}-${index}`}
                style={{
                  background: "#111",
                  border: "1px solid #333",
                  borderRadius: "12px",
                  padding: "14px",
                  marginTop: "10px",
                }}
              >
                <div style={{ fontWeight: "bold" }}>
                  {buildStepInstruction(step)}
                </div>
                <div style={{ color: "#bbb", marginTop: "6px" }}>
                  {formatDistance(step.distance)} •{" "}
                  {formatDuration(step.duration)}
                </div>
              </div>
            ))}
          </div>
        )}

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
