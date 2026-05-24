#!/usr/bin/env python3
import urllib.request
import json
import os

def main():
    print("⚡ Fetching HDB Carpark Information from data.gov.sg API...")
    
    # Dataset resource ID for HDB Carpark Information
    resource_id = "d_23f946fa557947f93a8043bbef41dd09"
    url = f"https://data.gov.sg/api/action/datastore_search?resource_id={resource_id}&limit=3500"
    
    try:
        req = urllib.request.Request(
            url, 
            headers={'User-Agent': 'Mozilla/5.0'}
        )
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode())
            
        records = data.get('result', {}).get('records', [])
        print(f"📦 Successfully downloaded {len(records)} raw HDB records!")
        
        compiled_carparks = []
        
        for r in records:
            carpark_no = r.get('car_park_no')
            address = r.get('address')
            x_coord = r.get('x_coord')
            y_coord = r.get('y_coord')
            
            # Skip records without valid coordinates
            if not carpark_no or not x_coord or not y_coord:
                continue
                
            try:
                x = float(x_coord)
                y = float(y_coord)
            except ValueError:
                continue
                
            compiled_carparks.append({
                "no": carpark_no,
                "addr": address,
                "x": x,
                "y": y,
                "sys": r.get('type_of_parking_system', 'UNKNOWN'),
                "free": r.get('free_parking', 'NO'),
                "h": r.get('gantry_height', '0.0')
            })
            
        print(f"✨ Processed and cleaned {len(compiled_carparks)} HDB carparks with coordinates.")
        
        # Save to JSON
        output_path = os.path.join(os.path.dirname(__file__), "carparks_db.json")
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(compiled_carparks, f, ensure_ascii=False, indent=2)
            
        print(f"🎉 Database compiled successfully: {output_path} ({os.path.getsize(output_path) // 1024} KB)")
        
    except Exception as e:
        print(f"❌ Error occurred: {e}")

if __name__ == "__main__":
    main()
