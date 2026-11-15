"""
SEDRION predictor - fits the saved SIMULATED-data model (models/sedrion_rf.joblib) into the existing pipeline.

Per node:
  1. If models/node_<id>.pkl exists (trained on REAL logs by train_model.py) -> use it (your original 5 features).
  2. Otherwise -> bootstrap model trained on simulated data (3 inputs: minutes since emptied, TOF cm, rain ADC).
Result is written to the predictions table in HOURS, keyed by site so db.getLatestPredictionForSite() finds it.

Run once:   python predict.py          Run forever (every 5 min):   python predict.py --loop
"""
import os, sys, time
import numpy as np
import pandas as pd
import joblib
import psycopg2
from pathlib import Path

DB_CONFIG = {
    "host": "localhost",
    "port": 5432,
    "database": "sedrion",
    "user": "postgres",
    "password": os.environ.get("PGPASSWORD", "ruru0431"),   # env var first, else edit this line
}

MODELS_DIR = Path(__file__).resolve().parent / "models"   # the "models" folder next to this file
BOOTSTRAP_MODEL = MODELS_DIR / "sedrion_rf.joblib"
LOOP_EVERY_MIN = 5
RAIN_IS_INVERTED = True      # True  = dry reads HIGH, wet reads LOW (YL-83 as simulated).  False = the opposite.
RAIN_MAX = 4095              # 12-bit ADC
FULL_CM = 5.0                # bucket counts as FULL at <= 5 cm  (simulation assumes empty = 31 cm)
BOOT_FEATURES = ["time_minutes", "tof_distance_cm", "rain_sensor_adc"]


# ---------- database helpers ----------
def get_recent_readings(conn, node_id, limit=10):
    return pd.read_sql(
        "SELECT * FROM sensor_readings WHERE node_id = %(node_id)s ORDER BY time DESC LIMIT %(limit)s",
        conn, params={"node_id": node_id, "limit": limit})


def get_site_id(conn, node_id):
    r = pd.read_sql("SELECT site_id FROM nodes WHERE node_id = %(n)s", conn, params={"n": node_id})
    return None if r.empty else int(r.iloc[0]["site_id"])


def get_last_clear_time(conn, site_id, now):
    """maintenance_events is keyed by SITE (see db.insertClearEvent), not node."""
    r = pd.read_sql(
        "SELECT cleared_at FROM maintenance_events WHERE site_id = %(s)s AND cleared_at <= %(now)s "
        "ORDER BY cleared_at DESC LIMIT 1", conn, params={"s": site_id, "now": now})
    return None if r.empty else r.iloc[0]["cleared_at"]


def get_first_reading_time(conn, node_id):
    r = pd.read_sql("SELECT MIN(time) AS t FROM sensor_readings WHERE node_id = %(n)s", conn, params={"n": node_id})
    return r.iloc[0]["t"]


# ---------- feature helpers ----------
def calculate_rate_of_change(readings):
    """mm/hour, positive = filling faster. Same as your original."""
    if len(readings) < 2:
        return 0
    readings = readings.sort_values('time').reset_index(drop=True)
    valid = readings[readings['tof_mm'] >= 0]
    if len(valid) < 2:
        return 0
    hours = (valid['time'] - valid['time'].iloc[0]).dt.total_seconds() / 3600
    slope, _ = np.polyfit(hours, valid['tof_mm'], 1)
    return -slope


def bootstrap_hours(model, minutes_since_clear, tof_mm_values, rain_values):
    """Pure function (easy to test). tof in mm -> cm; rain -> ADC the model expects; minutes -> hours out."""
    tof_cm = float(np.median(tof_mm_values)) / 10.0              # median of recent readings: kills splash/stale spikes
    if tof_cm <= FULL_CM:
        return 0.0
    rain = float(np.median(rain_values))
    adc = rain if RAIN_IS_INVERTED else RAIN_MAX - rain
    X = pd.DataFrame([[minutes_since_clear, tof_cm, adc]], columns=BOOT_FEATURES)
    return max(float(model.predict(X)[0]), 0.0) / 60.0


# ---------- per-node prediction ----------
def predict_for_node(conn, node_id, boot_model):
    recent = get_recent_readings(conn, node_id, limit=10)
    valid = recent[recent['tof_mm'] >= 0]                       # tof_mm == -1 means invalid reading
    if valid.empty:
        print(f"{node_id}: no valid readings yet")
        return
    site_id = get_site_id(conn, node_id)
    if site_id is None:
        print(f"{node_id}: not registered to a site, skipping")
        return

    latest = valid.iloc[0]                                      # newest valid (ORDER BY time DESC)
    last_clear = get_last_clear_time(conn, site_id, latest['time'])
    if last_clear is None:                                      # never cleared: assume bucket started empty
        last_clear = get_first_reading_time(conn, node_id)
        print(f"{node_id}: no clear event logged, counting from first reading")
    since_clear = (latest['time'] - last_clear).total_seconds()

    real_path = MODELS_DIR / f"node_{node_id}.pkl"
    if real_path.exists():                                      # model trained on REAL logs
        features = pd.DataFrame([{
            'tof_mm': latest['tof_mm'], 'rain': latest['rain'],
            'time_since_last_clear_hours': since_clear / 3600,
            'hour_of_day': latest['time'].hour,
            'tof_rate_of_change': calculate_rate_of_change(recent),
        }])
        hours = float(joblib.load(real_path).predict(features)[0])
        source = "real-data model"
    else:                                                       # bootstrap: simulated-data model
        hours = bootstrap_hours(boot_model, since_clear / 60, valid.head(5)['tof_mm'], valid.head(5)['rain'])
        source = "SIMULATED-data model"

    cur = conn.cursor()
    cur.execute("INSERT INTO predictions (site_id, node_id, predicted_at, predicted_hours_remaining) "
                "VALUES (%s, %s, NOW(), %s)", (site_id, node_id, hours))
    conn.commit()
    print(f"{node_id} (site {site_id}): ~{hours:.1f} h until full  [{source}]")


def run_once():
    conn = psycopg2.connect(**DB_CONFIG)
    boot_model = joblib.load(BOOTSTRAP_MODEL)
    for node_id in pd.read_sql("SELECT DISTINCT node_id FROM sensor_readings", conn)['node_id'].tolist():
        try:
            predict_for_node(conn, node_id, boot_model)
        except Exception as exc:
            conn.rollback()
            print(f"{node_id}: failed -> {exc}")
    conn.close()


if __name__ == "__main__":
    if "--loop" in sys.argv:
        while True:
            run_once()
            time.sleep(LOOP_EVERY_MIN * 60)
    else:
        run_once()
