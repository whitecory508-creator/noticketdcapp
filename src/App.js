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
  useMap,
} from "react-leaflet";

const DC_CAMERA_API =
  "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Public_Safety_WebMercator/MapServer/47/query?f=json&where=1%3D1&outFields=ENFORCEMENT_SPACE_CODE,LOCATION_DESCRIPTION,SITE_CODE,ACTIVE_STATUS,CAMERA_STATUS,DEVICE_MOBILITY,ENFORCEMENT_TYPE,SPEED_LIMIT,CAMERA_LATITUDE,CAMERA_LONGITUDE,WARD,ANC,SMD,OBJECTID";

const PREF_KEYS = {
  voiceEnabled: "noticket_voice_enabled",
  showSpeed: "noticket_show_speed",
  showRedLight: "noticket_show_red_light",
  showStopSign: "noticket_show_stop_sign",
  showOther: "noticket_show_other",
};

const ALERT_DISTANCE_FEET = 500;
const ALERT_DISTANCE_METERS = ALERT_DISTANCE_FEET / 3.28084;

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
  if (!Number.isFinite(meters)) return "--";
  const feet = metersToFeet(meters);
  if (feet < 528) return `${Math.round(feet)} ft`;
  return `${(feet / 5280).toFixed(2)} mi`;
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
  return smallestAngleDifference(userHeading, bearingToCamera) <= 75;
}

function toBool(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  return value === "true";
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

function cleanLocationText(camera) {
  const text =
    camera.description?.trim() ||
    camera.name?.trim() ||
    "the road ahead";

  return text
    .replace(/\s+/g, " ")
    .replace(/\bNW\b/g, "northwest")
    .replace(/\bNE\b/g, "northeast")
    .replace(/\bSW\b/g, "southwest")
    .replace(/\bSE\b/g, "southeast")
    .replace(/\bN\/B\b/g, "northbound")
    .replace(/\bS\/B\b/g, "southbound")
    .replace(/\bE\/B\b/g, "eastbound")
    .replace(/\bW\/B\b/g, "westbound");
}

function getCameraAlertText(camera) {
  const locationText = cleanLocationText(camera);

  if (camera.type === "speed") {
    return `Speed camera ahead in 500 feet. ${locationText}.`;
  }

  if (camera.type === "red_light") {
    return `Red light camera ahead in 500 feet. ${locationText}.`;
  }

  if (camera.type === "stop_sign") {
    return `Stop sign camera ahead in 500 feet. ${locationText}.`;
  }

  if (camera.type === "bus_lane" || camera.type === "truck") {
    return `Traffic enforcement camera ahead in 500 feet. ${locationText}.`;
  }

  return `Traffic camera ahead in 500 feet. ${locationText}.`;
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
  const [cameraData, setCameraData] = useState([]);
  const [showSpeed, setShowSpeed] = useState(true);
  const [showRedLight, setShowRedLight] = useState(true);
  const [showStopSign, setShowStopSign] = useState(true);
  const [showOther, setShowOther] = useState(true);
  const [alertHistory, setAlertHistory] = useState([]);
  const [showAlertHistory, setShowAlertHistory] = useState(false);
  const [permissionReady, setPermissionReady] = useState(false);

  const watchIdRef = useRef(null);
  const nativeWatchCallbackIdRef = useRef(null);
  const spokenCameraIdsRef = useRef({});
  const insideRadiusIdsRef = useRef({});

  useEffect(() => {
    async function bootstrap() {
      try {
        const prefs = await loadPrefs();
        setVoiceEnabled(toBool(prefs[PREF_KEYS.voiceEnabled], true));
        setShowSpeed(toBool(prefs[PREF_KEYS.showSpeed], true));
        setShowRedLight(toBool(prefs[PREF_KEYS.showRedLight], true));
        setShowStopSign(toBool(prefs[PREF_KEYS.showStopSign], true));
        setShowOther(toBool(prefs[PREF_KEYS.showOther], true));
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
    savePref(PREF_KEYS.showSpeed, showSpeed);
    savePref(PREF_KEYS.showRedLight, showRedLight);
    savePref(PREF_KEYS.showStopSign, showStopSign);
    savePref(PREF_KEYS.showOther, showOther);
  }, [showSpeed, showRedLight, showStopSign, showOther, prefsLoaded]);

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
          `Loaded ${mapped.length} Washington, DC traffic cameras. Press start to begin alerts.`
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

  const cameras = useMemo(() => {
    const filtered = cameraData.filter((camera) => {
      if (camera.type === "speed") return showSpeed;
      if (camera.type === "red_light") return showRedLight;
      if (camera.type === "stop_sign") return showStopSign;
      return showOther;
    });

    if (!position) {
      return filtered.map((camera) => ({
        ...camera,
        distanceMeters: Infinity,
        bearingToCamera: null,
        ahead: true,
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

        return {
          ...camera,
          distanceMeters,
          bearingToCamera,
          ahead,
        };
      })
      .sort((a, b) => {
        if (a.ahead && !b.ahead) return -1;
        if (!a.ahead && b.ahead) return 1;
        return a.distanceMeters - b.distanceMeters;
      });
  }, [position, cameraData, showSpeed, showRedLight, showStopSign, showOther]);

  useEffect(() => {
    if (!started || !position || cameras.length === 0) return;

    const currentInsideRadius = {};

    cameras.forEach((camera) => {
      if (
        Number.isFinite(camera.distanceMeters) &&
        camera.distanceMeters <= ALERT_DISTANCE_METERS &&
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

    const candidates = cameras.filter((camera) => {
      if (!Number.isFinite(camera.distanceMeters)) return false;
      if (camera.distanceMeters > ALERT_DISTANCE_METERS) return false;
      if (!camera.ahead) return false;
      return true;
    });

    if (candidates.length === 0) {
      setStatus("Traffic camera alerts are active. No immediate alerts right now.");
      return;
    }

    const selected = candidates[0];
    const alreadyInside = !!insideRadiusIdsRef.current[selected.id];
    const alreadySpoken = !!spokenCameraIdsRef.current[selected.id];

    if (!alreadyInside && !alreadySpoken) {
      const text = getCameraAlertText(selected);

      spokenCameraIdsRef.current[selected.id] = true;
      insideRadiusIdsRef.current[selected.id] = true;

      const newEntry = {
        id: `${selected.id}-${Date.now()}`,
        text,
        time: new Date().toLocaleTimeString(),
      };

      setAlertHistory((prev) => [newEntry, ...prev].slice(0, 20));
      setLastAlert(text);

      if (voiceEnabled) {
        speakText(text);
      }

      fireLocalNotification(
        "NoTicket DC",
        text,
        Number(String(Date.now()).slice(-8))
      );

      setStatus("Traffic camera alert triggered.");
    } else if (!alreadyInside) {
      insideRadiusIdsRef.current[selected.id] = true;
    }
  }, [started, position, cameras, voiceEnabled]);

  async function startCameraAlerts() {
    try {
      setLocationError("");
      setStarted(true);
      setStatus("Requesting location access for traffic camera alerts...");
      spokenCameraIdsRef.current = {};
      insideRadiusIdsRef.current = {};

      if (isNativeApp()) {
        const locationGranted = await requestLocationPermission();
        await requestNotificationPermission();

        if (!locationGranted) {
          setLocationError(
            "Location permission denied. Please allow location access."
          );
          setStatus("Location permission denied.");
          setStarted(false);
          return;
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
              setStatus("Traffic camera alerts are active. Tracking location live.");
            }
          }
        );

        return;
      }

      if (!navigator.geolocation) {
        setLocationError("Geolocation is not supported on this device/browser.");
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
          setStatus("Traffic camera alerts are active. Tracking location live.");
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

  async function stopCameraAlerts() {
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

    setStarted(false);
    setStatus("Traffic camera alerts stopped.");
    insideRadiusIdsRef.current = {};
  }

  const nearestAhead = cameras.find((camera) => camera.ahead) || null;
  const nearest = nearestAhead || cameras[0] || null;
  const camerasAhead = cameras.filter((camera) => camera.ahead).length;
  const userHeading = position
    ? getCardinalDirection(getHeadingDegrees(position.coords))
    : "--";

  const mapCenter = position?.coords
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
          Traffic Enforcement Camera Alerts
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
          <h2 style={{ marginTop: 0 }}>Camera Alerts</h2>
          <p style={{ color: "#bbb", lineHeight: 1.6 }}>
            This app gives spoken warnings for Washington, DC traffic enforcement
            cameras. Alerts trigger at 500 feet and only for cameras in the
            driver&apos;s direction.
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
                onClick={startCameraAlerts}
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
                onClick={stopCameraAlerts}
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
                const sampleCamera = {
                  type: "red_light",
                  description: "M St W/B @ Wisconsin Ave NW",
                  name: "ATE 0813",
                };
                const text = getCameraAlertText(sampleCamera);
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
              Test Camera Alert
            </button>

            <button
              onClick={() => setShowAlertHistory((prev) => !prev)}
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
              {showAlertHistory ? "Hide Recent Alerts" : "Show Recent Alerts"}
            </button>
          </div>

          <div
            style={{
              marginTop: "18px",
              borderRadius: "14px",
              overflow: "hidden",
              border: "1px solid #333",
            }}
          >
            <MapContainer
              key={`${mapCenter[0]}-${mapCenter[1]}`}
              center={mapCenter}
              zoom={13}
              scrollWheelZoom={true}
              style={{ height: "460px", width: "100%" }}
            >
              <RecenterMap center={mapCenter} zoom={13} />

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

              {cameras.slice(0, 250).map((camera) => (
                <CircleMarker
                  key={camera.id}
                  center={[camera.lat, camera.lng]}
                  radius={camera.ahead ? 7 : 5}
                  pathOptions={{
                    color: getCameraColor(camera),
                    fillColor: getCameraColor(camera),
                    fillOpacity: camera.ahead ? 0.95 : 0.65,
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
                        {camera.ahead ? "Ahead of driver" : "Other direction"}
                      </div>
                    </div>
                  </Popup>
                </CircleMarker>
              ))}
            </MapContainer>
          </div>
        </div>

        {showAlertHistory && (
          <div style={{ marginTop: "24px" }}>
            <h2>Recent Alerts</h2>
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
            <strong>Alert distance:</strong> 500 feet
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
                checked={showStopSign}
                onChange={(e) => setShowStopSign(e.target.checked)}
                style={{ marginRight: "8px" }}
              />
              Stop sign cameras
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
