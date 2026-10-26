export interface Airport {
  icao: string;
  iata?: string;
  name: string;
  city: string;
  lat: number;
  lon: number;
  /** Field elevation (ft MSL). 0 for ad-hoc drops; ground height is then sampled from the 3D tiles. */
  elevFt: number;
  custom?: boolean;
}

/** Busy airports with an aerodrome reference point near the runway complex. */
export const AIRPORTS: Airport[] = [
  { icao: "KATL", iata: "ATL", name: "Hartsfield-Jackson Atlanta", city: "Atlanta", lat: 33.6407, lon: -84.4277, elevFt: 1026 },
  { icao: "KDFW", iata: "DFW", name: "Dallas/Fort Worth", city: "Dallas", lat: 32.8998, lon: -97.0403, elevFt: 607 },
  { icao: "KDEN", iata: "DEN", name: "Denver International", city: "Denver", lat: 39.8561, lon: -104.6737, elevFt: 5434 },
  { icao: "KORD", iata: "ORD", name: "Chicago O'Hare", city: "Chicago", lat: 41.9742, lon: -87.9073, elevFt: 672 },
  { icao: "KLAX", iata: "LAX", name: "Los Angeles International", city: "Los Angeles", lat: 33.9416, lon: -118.4085, elevFt: 125 },
  { icao: "KJFK", iata: "JFK", name: "John F. Kennedy International", city: "New York", lat: 40.6413, lon: -73.7781, elevFt: 13 },
  { icao: "KLGA", iata: "LGA", name: "LaGuardia", city: "New York", lat: 40.7769, lon: -73.874, elevFt: 21 },
  { icao: "KEWR", iata: "EWR", name: "Newark Liberty", city: "Newark", lat: 40.6895, lon: -74.1745, elevFt: 18 },
  { icao: "KLAS", iata: "LAS", name: "Harry Reid International", city: "Las Vegas", lat: 36.084, lon: -115.1537, elevFt: 2181 },
  { icao: "KMCO", iata: "MCO", name: "Orlando International", city: "Orlando", lat: 28.4312, lon: -81.3081, elevFt: 96 },
  { icao: "KMIA", iata: "MIA", name: "Miami International", city: "Miami", lat: 25.7959, lon: -80.287, elevFt: 8 },
  { icao: "KCLT", iata: "CLT", name: "Charlotte Douglas", city: "Charlotte", lat: 35.2144, lon: -80.9473, elevFt: 748 },
  { icao: "KSEA", iata: "SEA", name: "Seattle-Tacoma", city: "Seattle", lat: 47.4502, lon: -122.3088, elevFt: 433 },
  { icao: "KPHX", iata: "PHX", name: "Phoenix Sky Harbor", city: "Phoenix", lat: 33.4342, lon: -112.0116, elevFt: 1135 },
  { icao: "KSFO", iata: "SFO", name: "San Francisco International", city: "San Francisco", lat: 37.6213, lon: -122.379, elevFt: 13 },
  { icao: "KIAH", iata: "IAH", name: "George Bush Intercontinental", city: "Houston", lat: 29.9902, lon: -95.3368, elevFt: 97 },
  { icao: "KBOS", iata: "BOS", name: "Boston Logan", city: "Boston", lat: 42.3656, lon: -71.0096, elevFt: 20 },
  { icao: "KMSP", iata: "MSP", name: "Minneapolis-Saint Paul", city: "Minneapolis", lat: 44.8848, lon: -93.2223, elevFt: 841 },
  { icao: "KDTW", iata: "DTW", name: "Detroit Metropolitan", city: "Detroit", lat: 42.2162, lon: -83.3554, elevFt: 645 },
  { icao: "KPHL", iata: "PHL", name: "Philadelphia International", city: "Philadelphia", lat: 39.8744, lon: -75.2424, elevFt: 36 },
  { icao: "KIAD", iata: "IAD", name: "Washington Dulles", city: "Washington", lat: 38.9531, lon: -77.4565, elevFt: 313 },
  { icao: "KDCA", iata: "DCA", name: "Ronald Reagan Washington National", city: "Washington", lat: 38.8512, lon: -77.0402, elevFt: 15 },
  { icao: "CYYZ", iata: "YYZ", name: "Toronto Pearson", city: "Toronto", lat: 43.6777, lon: -79.6248, elevFt: 569 },
  { icao: "CYVR", iata: "YVR", name: "Vancouver International", city: "Vancouver", lat: 49.1967, lon: -123.1815, elevFt: 14 },
  { icao: "MMMX", iata: "MEX", name: "Mexico City International", city: "Mexico City", lat: 19.4361, lon: -99.0719, elevFt: 7316 },
  { icao: "SBGR", iata: "GRU", name: "São Paulo/Guarulhos", city: "São Paulo", lat: -23.4356, lon: -46.4731, elevFt: 2459 },
  { icao: "SKBO", iata: "BOG", name: "El Dorado International", city: "Bogotá", lat: 4.7016, lon: -74.1469, elevFt: 8361 },
  { icao: "SCEL", iata: "SCL", name: "Santiago International", city: "Santiago", lat: -33.393, lon: -70.7858, elevFt: 1555 },
  { icao: "SAEZ", iata: "EZE", name: "Ministro Pistarini", city: "Buenos Aires", lat: -34.8222, lon: -58.5358, elevFt: 66 },
  { icao: "EGLL", iata: "LHR", name: "London Heathrow", city: "London", lat: 51.47, lon: -0.4543, elevFt: 83 },
  { icao: "EGKK", iata: "LGW", name: "London Gatwick", city: "London", lat: 51.1537, lon: -0.1821, elevFt: 202 },
  { icao: "LFPG", iata: "CDG", name: "Paris Charles de Gaulle", city: "Paris", lat: 49.0097, lon: 2.5479, elevFt: 392 },
  { icao: "EHAM", iata: "AMS", name: "Amsterdam Schiphol", city: "Amsterdam", lat: 52.3105, lon: 4.7683, elevFt: -11 },
  { icao: "EDDF", iata: "FRA", name: "Frankfurt am Main", city: "Frankfurt", lat: 50.0379, lon: 8.5622, elevFt: 364 },
  { icao: "EDDM", iata: "MUC", name: "Munich", city: "Munich", lat: 48.3537, lon: 11.775, elevFt: 1487 },
  { icao: "LEMD", iata: "MAD", name: "Adolfo Suárez Madrid-Barajas", city: "Madrid", lat: 40.4983, lon: -3.5676, elevFt: 1998 },
  { icao: "LEBL", iata: "BCN", name: "Barcelona-El Prat", city: "Barcelona", lat: 41.2974, lon: 2.0833, elevFt: 12 },
  { icao: "LIRF", iata: "FCO", name: "Rome Fiumicino", city: "Rome", lat: 41.8003, lon: 12.2389, elevFt: 13 },
  { icao: "LSZH", iata: "ZRH", name: "Zurich", city: "Zurich", lat: 47.4582, lon: 8.5555, elevFt: 1416 },
  { icao: "LOWW", iata: "VIE", name: "Vienna International", city: "Vienna", lat: 48.1103, lon: 16.5697, elevFt: 600 },
  { icao: "EKCH", iata: "CPH", name: "Copenhagen Kastrup", city: "Copenhagen", lat: 55.618, lon: 12.6508, elevFt: 17 },
  { icao: "ENGM", iata: "OSL", name: "Oslo Gardermoen", city: "Oslo", lat: 60.1976, lon: 11.1004, elevFt: 681 },
  { icao: "ESSA", iata: "ARN", name: "Stockholm Arlanda", city: "Stockholm", lat: 59.6498, lon: 17.9238, elevFt: 137 },
  { icao: "EIDW", iata: "DUB", name: "Dublin", city: "Dublin", lat: 53.4264, lon: -6.2499, elevFt: 242 },
  { icao: "LTFM", iata: "IST", name: "Istanbul Airport", city: "Istanbul", lat: 41.2753, lon: 28.7519, elevFt: 325 },
  { icao: "UUEE", iata: "SVO", name: "Moscow Sheremetyevo", city: "Moscow", lat: 55.9726, lon: 37.4146, elevFt: 630 },
  { icao: "OMDB", iata: "DXB", name: "Dubai International", city: "Dubai", lat: 25.2532, lon: 55.3657, elevFt: 62 },
  { icao: "OMAA", iata: "AUH", name: "Zayed International", city: "Abu Dhabi", lat: 24.433, lon: 54.6511, elevFt: 88 },
  { icao: "OTHH", iata: "DOH", name: "Hamad International", city: "Doha", lat: 25.2731, lon: 51.6081, elevFt: 13 },
  { icao: "OERK", iata: "RUH", name: "King Khalid International", city: "Riyadh", lat: 24.9576, lon: 46.6988, elevFt: 2049 },
  { icao: "OEJN", iata: "JED", name: "King Abdulaziz International", city: "Jeddah", lat: 21.6796, lon: 39.1565, elevFt: 48 },
  { icao: "LLBG", iata: "TLV", name: "Ben Gurion", city: "Tel Aviv", lat: 32.0055, lon: 34.8854, elevFt: 135 },
  { icao: "HECA", iata: "CAI", name: "Cairo International", city: "Cairo", lat: 30.1219, lon: 31.4056, elevFt: 382 },
  { icao: "FAOR", iata: "JNB", name: "O. R. Tambo International", city: "Johannesburg", lat: -26.1367, lon: 28.2411, elevFt: 5558 },
  { icao: "HKJK", iata: "NBO", name: "Jomo Kenyatta International", city: "Nairobi", lat: -1.3192, lon: 36.9278, elevFt: 5330 },
  { icao: "DNMM", iata: "LOS", name: "Murtala Muhammed International", city: "Lagos", lat: 6.5774, lon: 3.3215, elevFt: 135 },
  { icao: "VIDP", iata: "DEL", name: "Indira Gandhi International", city: "Delhi", lat: 28.5562, lon: 77.1, elevFt: 777 },
  { icao: "VABB", iata: "BOM", name: "Chhatrapati Shivaji Maharaj", city: "Mumbai", lat: 19.0896, lon: 72.8656, elevFt: 39 },
  { icao: "VOBL", iata: "BLR", name: "Kempegowda International", city: "Bengaluru", lat: 13.1986, lon: 77.7066, elevFt: 3000 },
  { icao: "OPKC", iata: "KHI", name: "Jinnah International", city: "Karachi", lat: 24.9065, lon: 67.1608, elevFt: 100 },
  { icao: "OPLA", iata: "LHE", name: "Allama Iqbal International", city: "Lahore", lat: 31.5216, lon: 74.4036, elevFt: 712 },
  { icao: "OPIS", iata: "ISB", name: "Islamabad International", city: "Islamabad", lat: 33.5491, lon: 72.8257, elevFt: 1761 },
  { icao: "VTBS", iata: "BKK", name: "Suvarnabhumi", city: "Bangkok", lat: 13.69, lon: 100.7501, elevFt: 5 },
  { icao: "WSSS", iata: "SIN", name: "Singapore Changi", city: "Singapore", lat: 1.3644, lon: 103.9915, elevFt: 22 },
  { icao: "WMKK", iata: "KUL", name: "Kuala Lumpur International", city: "Kuala Lumpur", lat: 2.7456, lon: 101.7072, elevFt: 69 },
  { icao: "WIII", iata: "CGK", name: "Soekarno-Hatta", city: "Jakarta", lat: -6.1256, lon: 106.6559, elevFt: 34 },
  { icao: "RPLL", iata: "MNL", name: "Ninoy Aquino International", city: "Manila", lat: 14.5086, lon: 121.0194, elevFt: 75 },
  { icao: "VHHH", iata: "HKG", name: "Hong Kong International", city: "Hong Kong", lat: 22.308, lon: 113.9185, elevFt: 28 },
  { icao: "RCTP", iata: "TPE", name: "Taoyuan International", city: "Taipei", lat: 25.0797, lon: 121.2342, elevFt: 106 },
  { icao: "ZBAA", iata: "PEK", name: "Beijing Capital", city: "Beijing", lat: 40.0799, lon: 116.6031, elevFt: 116 },
  { icao: "ZBAD", iata: "PKX", name: "Beijing Daxing", city: "Beijing", lat: 39.5098, lon: 116.4105, elevFt: 98 },
  { icao: "ZSPD", iata: "PVG", name: "Shanghai Pudong", city: "Shanghai", lat: 31.1443, lon: 121.8083, elevFt: 13 },
  { icao: "ZGGG", iata: "CAN", name: "Guangzhou Baiyun", city: "Guangzhou", lat: 23.3924, lon: 113.2988, elevFt: 50 },
  { icao: "RJTT", iata: "HND", name: "Tokyo Haneda", city: "Tokyo", lat: 35.5494, lon: 139.7798, elevFt: 35 },
  { icao: "RJAA", iata: "NRT", name: "Tokyo Narita", city: "Tokyo", lat: 35.772, lon: 140.3929, elevFt: 141 },
  { icao: "RKSI", iata: "ICN", name: "Incheon International", city: "Seoul", lat: 37.4602, lon: 126.4407, elevFt: 23 },
  { icao: "YSSY", iata: "SYD", name: "Sydney Kingsford Smith", city: "Sydney", lat: -33.9399, lon: 151.1753, elevFt: 21 },
  { icao: "YMML", iata: "MEL", name: "Melbourne Tullamarine", city: "Melbourne", lat: -37.669, lon: 144.841, elevFt: 434 },
  { icao: "NZAA", iata: "AKL", name: "Auckland", city: "Auckland", lat: -37.0082, lon: 174.785, elevFt: 23 },
];

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function nearestAirport(lat: number, lon: number, maxKm: number): Airport | null {
  let best: Airport | null = null;
  let bestKm = maxKm;
  for (const a of AIRPORTS) {
    const d = distanceKm(lat, lon, a.lat, a.lon);
    if (d <= bestKm) {
      best = a;
      bestKm = d;
    }
  }
  return best;
}

export function searchAirports(query: string): Airport[] {
  const q = query.trim().toLowerCase();
  if (!q) return AIRPORTS;
  return AIRPORTS.filter(
    (a) =>
      a.icao.toLowerCase().includes(q) ||
      a.iata?.toLowerCase().includes(q) ||
      a.name.toLowerCase().includes(q) ||
      a.city.toLowerCase().includes(q),
  );
}

/** An ad-hoc airport at an arbitrary point (e.g. the current map centre). */
export function customAirport(lat: number, lon: number): Airport {
  const known = nearestAirport(lat, lon, 4);
  if (known) return known;
  return {
    icao: "DROP",
    name: `Drop point ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    city: "Custom",
    lat,
    lon,
    elevFt: 0,
    custom: true,
  };
}
