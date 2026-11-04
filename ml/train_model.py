import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error
import joblib
import psycopg2

DB_CONFIG = {
    "host": "localhost",
    "port": 5432,
    "database": "sedrion",
    "user": "postgres",
    "password": "YOUR_POSTGRES_PASSWORD",
}


def get_node_ids(conn):
    return pd.read_sql("SELECT DISTINCT node_id FROM sensor_readings", conn)['node_id'].tolist()


def compute_rolling_rate(readings, window=10):
    """
    For each reading, fit a trend line through up to `window` prior readings
    (including itself) to get a smoothed rate of change in mm/hour.
    Positive value = filling faster (distance decreasing).
    Ignores invalid readings (tof_mm == -1).
    """
    readings = readings.sort_values('time').reset_index(drop=True)
    rates = []

    for i in range(len(readings)):
        window_data = readings.iloc[max(0, i - window + 1): i + 1]
        valid = window_data[window_data['tof_mm'] >= 0]

        if len(valid) < 2:
            rates.append(0)
            continue

        hours_elapsed = (valid['time'] - valid['time'].iloc[0]).dt.total_seconds() / 3600
        slope, _ = np.polyfit(hours_elapsed, valid['tof_mm'], 1)
        rates.append(-slope)

    readings['tof_rate_of_change'] = rates
    return readings


def build_training_data(conn, node_id):
    readings = pd.read_sql(
        "SELECT * FROM sensor_readings WHERE node_id = %(node_id)s ORDER BY time",
        conn, params={"node_id": node_id}
    )
    clears = pd.read_sql(
        "SELECT cleared_at FROM maintenance_events WHERE node_id = %(node_id)s ORDER BY cleared_at",
        conn, params={"node_id": node_id}
    )

    if readings.empty:
        return pd.DataFrame()

    readings = compute_rolling_rate(readings, window=10)

    rows = []
    for _, reading in readings.iterrows():
        future_clears = clears[clears['cleared_at'] > reading['time']]
        if future_clears.empty:
            continue

        next_clear = future_clears.iloc[0]['cleared_at']
        hours_until_full = (next_clear - reading['time']).total_seconds() / 3600

        past_clears = clears[clears['cleared_at'] <= reading['time']]
        last_clear = past_clears.iloc[-1]['cleared_at'] if not past_clears.empty else readings['time'].min()
        time_since_last_clear = (reading['time'] - last_clear).total_seconds() / 3600

        rows.append({
            'tof_mm': reading['tof_mm'],
            'rain': reading['rain'],
            'time_since_last_clear_hours': time_since_last_clear,
            'hour_of_day': reading['time'].hour,
            'tof_rate_of_change': reading['tof_rate_of_change'],
            'target_hours_until_full': hours_until_full,
        })

    return pd.DataFrame(rows)


def train_for_node(conn, node_id):
    df = build_training_data(conn, node_id)

    if len(df) < 20:
        print(f"Node {node_id}: not enough data yet ({len(df)} rows), skipping")
        return

    X = df.drop(columns=['target_hours_until_full'])
    y = df['target_hours_until_full']

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    model = RandomForestRegressor(n_estimators=200, random_state=42)
    model.fit(X_train, y_train)

    preds = model.predict(X_test)
    mae = mean_absolute_error(y_test, preds)
    print(f"Node {node_id}: trained on {len(df)} rows, MAE = {mae:.2f} hours")

    joblib.dump(model, f"models/node_{node_id}.pkl")


def main():
    conn = psycopg2.connect(**DB_CONFIG)
    for node_id in get_node_ids(conn):
        train_for_node(conn, node_id)
    conn.close()


if __name__ == "__main__":
    main()