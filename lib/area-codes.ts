/**
 * NANPA area code → state/province (+ a metro hint for the well-known ones).
 * Used to INFER where a buyer is when we only have a phone number (Kyle
 * 9/24). Inference, not fact: people keep cell numbers when they move, so
 * consumers should say "area code suggests …" rather than assert it.
 */

const S: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "Washington, DC",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska",
  NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick", NL: "Newfoundland and Labrador", NS: "Nova Scotia", ON: "Ontario",
  PE: "Prince Edward Island", QC: "Quebec", SK: "Saskatchewan", NT: "Northwest Territories", YT: "Yukon", NU: "Nunavut",
};

// code → [state, metro hint]
const CODES: Record<string, [string, string?]> = {
  // Alabama
  "205": ["AL", "Birmingham"], "251": ["AL", "Mobile"], "256": ["AL", "Huntsville"], "334": ["AL", "Montgomery"], "659": ["AL", "Birmingham"], "938": ["AL", "Huntsville"],
  // Alaska
  "907": ["AK"],
  // Arizona
  "480": ["AZ", "Phoenix East Valley"], "520": ["AZ", "Tucson"], "602": ["AZ", "Phoenix"], "623": ["AZ", "Phoenix West Valley"], "928": ["AZ", "Flagstaff / northern AZ"],
  // Arkansas
  "327": ["AR"], "479": ["AR", "Fayetteville / Fort Smith"], "501": ["AR", "Little Rock"], "870": ["AR"],
  // California
  "209": ["CA", "Stockton / Modesto"], "213": ["CA", "Los Angeles"], "279": ["CA", "Sacramento"], "310": ["CA", "West LA / South Bay"], "323": ["CA", "Los Angeles"],
  "341": ["CA", "Oakland / East Bay"], "350": ["CA", "Stockton / Modesto"], "369": ["CA", "North Bay"], "408": ["CA", "San Jose"], "415": ["CA", "San Francisco"],
  "424": ["CA", "West LA / South Bay"], "442": ["CA", "Palm Springs / Oceanside"], "510": ["CA", "Oakland / East Bay"], "530": ["CA", "Redding / Chico / Tahoe"],
  "559": ["CA", "Fresno"], "562": ["CA", "Long Beach"], "619": ["CA", "San Diego"], "626": ["CA", "Pasadena"], "628": ["CA", "San Francisco"],
  "650": ["CA", "Peninsula / Palo Alto"], "657": ["CA", "Orange County"], "661": ["CA", "Bakersfield / Santa Clarita"], "669": ["CA", "San Jose"],
  "707": ["CA", "North Bay / Santa Rosa"], "714": ["CA", "Orange County"], "747": ["CA", "San Fernando Valley"], "760": ["CA", "Palm Springs / Oceanside"],
  "805": ["CA", "Santa Barbara / Ventura"], "818": ["CA", "San Fernando Valley"], "820": ["CA", "Santa Barbara / Ventura"], "831": ["CA", "Monterey / Santa Cruz"],
  "840": ["CA", "San Bernardino"], "858": ["CA", "San Diego"], "909": ["CA", "San Bernardino"], "916": ["CA", "Sacramento"], "925": ["CA", "East Bay / Walnut Creek"],
  "949": ["CA", "South Orange County"], "951": ["CA", "Riverside"],
  // Colorado
  "303": ["CO", "Denver / Boulder"], "719": ["CO", "Colorado Springs / Pueblo"], "720": ["CO", "Denver / Boulder"], "970": ["CO", "Fort Collins / Grand Junction / mountains"], "983": ["CO", "Denver / Boulder"],
  // Connecticut
  "203": ["CT", "Bridgeport / New Haven"], "475": ["CT", "Bridgeport / New Haven"], "860": ["CT", "Hartford"], "959": ["CT", "Hartford"],
  // Delaware
  "302": ["DE"],
  // DC
  "202": ["DC"], "771": ["DC"],
  // Florida
  "239": ["FL", "Fort Myers / Naples"], "305": ["FL", "Miami"], "321": ["FL", "Orlando / Space Coast"], "352": ["FL", "Gainesville / Ocala"], "386": ["FL", "Daytona"],
  "407": ["FL", "Orlando"], "448": ["FL", "Tallahassee / Panhandle"], "561": ["FL", "West Palm Beach"], "656": ["FL", "Tampa"], "689": ["FL", "Orlando"],
  "727": ["FL", "St. Petersburg / Clearwater"], "754": ["FL", "Fort Lauderdale"], "772": ["FL", "Treasure Coast"], "786": ["FL", "Miami"], "813": ["FL", "Tampa"],
  "850": ["FL", "Tallahassee / Panhandle"], "863": ["FL", "Lakeland"], "904": ["FL", "Jacksonville"], "941": ["FL", "Sarasota"], "954": ["FL", "Fort Lauderdale"],
  // Georgia
  "229": ["GA", "Albany"], "404": ["GA", "Atlanta"], "470": ["GA", "Atlanta"], "478": ["GA", "Macon"], "678": ["GA", "Atlanta"], "706": ["GA", "Augusta / Columbus"], "762": ["GA", "Augusta / Columbus"], "770": ["GA", "Atlanta suburbs"], "912": ["GA", "Savannah"], "943": ["GA", "Atlanta"],
  // Hawaii
  "808": ["HI"],
  // Idaho
  "208": ["ID", "Boise"], "986": ["ID", "Boise"],
  // Illinois
  "217": ["IL", "Springfield / Champaign"], "224": ["IL", "Chicago suburbs"], "309": ["IL", "Peoria"], "312": ["IL", "Chicago"], "331": ["IL", "Chicago west suburbs"],
  "447": ["IL", "Springfield / Champaign"], "464": ["IL", "Chicago suburbs"], "618": ["IL", "southern IL"], "630": ["IL", "Chicago west suburbs"], "708": ["IL", "Chicago south suburbs"],
  "773": ["IL", "Chicago"], "779": ["IL", "Rockford"], "815": ["IL", "Rockford"], "847": ["IL", "Chicago north suburbs"], "872": ["IL", "Chicago"],
  // Indiana
  "219": ["IN", "Gary / NW Indiana"], "260": ["IN", "Fort Wayne"], "317": ["IN", "Indianapolis"], "463": ["IN", "Indianapolis"], "574": ["IN", "South Bend"], "765": ["IN"], "812": ["IN", "Evansville / Bloomington"], "930": ["IN", "Evansville / Bloomington"],
  // Iowa
  "319": ["IA", "Cedar Rapids"], "515": ["IA", "Des Moines"], "563": ["IA", "Davenport / Dubuque"], "641": ["IA"], "712": ["IA", "Sioux City"],
  // Kansas
  "316": ["KS", "Wichita"], "620": ["KS"], "785": ["KS", "Topeka"], "913": ["KS", "Kansas City area"],
  // Kentucky
  "270": ["KY", "Bowling Green"], "364": ["KY", "Bowling Green"], "502": ["KY", "Louisville"], "606": ["KY", "eastern KY"], "859": ["KY", "Lexington"],
  // Louisiana
  "225": ["LA", "Baton Rouge"], "318": ["LA", "Shreveport"], "337": ["LA", "Lafayette"], "504": ["LA", "New Orleans"], "985": ["LA", "Houma / Northshore"],
  // Maine
  "207": ["ME"],
  // Maryland
  "240": ["MD", "DC suburbs"], "301": ["MD", "DC suburbs"], "410": ["MD", "Baltimore"], "443": ["MD", "Baltimore"], "667": ["MD", "Baltimore"],
  // Massachusetts
  "339": ["MA", "Boston suburbs"], "351": ["MA", "Lowell"], "413": ["MA", "Springfield / western MA"], "508": ["MA", "Worcester / Cape Cod"], "617": ["MA", "Boston"], "774": ["MA", "Worcester / Cape Cod"], "781": ["MA", "Boston suburbs"], "857": ["MA", "Boston"], "978": ["MA", "Lowell"],
  // Michigan
  "231": ["MI", "Traverse City / NW Michigan"], "248": ["MI", "Oakland County"], "269": ["MI", "Kalamazoo"], "313": ["MI", "Detroit"], "517": ["MI", "Lansing"],
  "586": ["MI", "Macomb County"], "616": ["MI", "Grand Rapids"], "679": ["MI", "Detroit"], "734": ["MI", "Ann Arbor"], "810": ["MI", "Flint"], "906": ["MI", "Upper Peninsula"], "947": ["MI", "Oakland County"], "989": ["MI", "Saginaw / central MI"],
  // Minnesota
  "218": ["MN", "Duluth / northern MN"], "320": ["MN", "St. Cloud"], "507": ["MN", "Rochester"], "612": ["MN", "Minneapolis"], "651": ["MN", "St. Paul"], "763": ["MN", "Minneapolis NW suburbs"], "952": ["MN", "Minneapolis SW suburbs"],
  // Mississippi
  "228": ["MS", "Gulf Coast"], "601": ["MS", "Jackson"], "662": ["MS", "northern MS"], "769": ["MS", "Jackson"],
  // Missouri
  "314": ["MO", "St. Louis"], "417": ["MO", "Springfield"], "557": ["MO", "St. Louis"], "573": ["MO", "Columbia / Jefferson City"], "636": ["MO", "St. Louis west suburbs"], "660": ["MO"], "816": ["MO", "Kansas City"], "975": ["MO", "Kansas City"],
  // Montana
  "406": ["MT"],
  // Nebraska
  "308": ["NE", "western NE"], "402": ["NE", "Omaha / Lincoln"], "531": ["NE", "Omaha / Lincoln"],
  // Nevada
  "702": ["NV", "Las Vegas"], "725": ["NV", "Las Vegas"], "775": ["NV", "Reno / rural NV"],
  // New Hampshire
  "603": ["NH"],
  // New Jersey
  "201": ["NJ", "Jersey City / Hackensack"], "551": ["NJ", "Jersey City / Hackensack"], "609": ["NJ", "Trenton / Atlantic City"], "640": ["NJ", "Trenton / Atlantic City"],
  "732": ["NJ", "central NJ"], "848": ["NJ", "central NJ"], "856": ["NJ", "Camden / south NJ"], "862": ["NJ", "Newark"], "908": ["NJ", "Elizabeth / north-central NJ"], "973": ["NJ", "Newark"],
  // New Mexico
  "505": ["NM", "Albuquerque / Santa Fe"], "575": ["NM", "Las Cruces"],
  // New York
  "212": ["NY", "Manhattan"], "315": ["NY", "Syracuse"], "329": ["NY", "Syracuse"], "332": ["NY", "Manhattan"], "347": ["NY", "NYC outer boroughs"], "363": ["NY", "Long Island"],
  "516": ["NY", "Long Island / Nassau"], "518": ["NY", "Albany"], "585": ["NY", "Rochester"], "607": ["NY", "Binghamton / Ithaca"], "631": ["NY", "Long Island / Suffolk"],
  "646": ["NY", "Manhattan"], "680": ["NY", "Syracuse"], "716": ["NY", "Buffalo"], "718": ["NY", "NYC outer boroughs"], "838": ["NY", "Albany"], "845": ["NY", "Hudson Valley"],
  "914": ["NY", "Westchester"], "917": ["NY", "NYC"], "929": ["NY", "NYC outer boroughs"], "934": ["NY", "Long Island / Suffolk"],
  // North Carolina
  "252": ["NC", "eastern NC"], "336": ["NC", "Greensboro / Winston-Salem"], "472": ["NC", "Greensboro / Winston-Salem"], "704": ["NC", "Charlotte"], "743": ["NC", "Greensboro / Winston-Salem"],
  "828": ["NC", "Asheville / western NC"], "910": ["NC", "Wilmington / Fayetteville"], "919": ["NC", "Raleigh / Durham"], "980": ["NC", "Charlotte"], "984": ["NC", "Raleigh / Durham"],
  // North Dakota
  "701": ["ND"],
  // Ohio
  "216": ["OH", "Cleveland"], "220": ["OH", "SE Ohio"], "234": ["OH", "Akron / Canton"], "283": ["OH", "Cincinnati"], "326": ["OH", "Dayton"], "330": ["OH", "Akron / Canton"],
  "380": ["OH", "Columbus"], "419": ["OH", "Toledo"], "440": ["OH", "Cleveland suburbs"], "513": ["OH", "Cincinnati"], "567": ["OH", "Toledo"], "614": ["OH", "Columbus"], "740": ["OH", "SE Ohio"], "937": ["OH", "Dayton"],
  // Oklahoma
  "405": ["OK", "Oklahoma City"], "539": ["OK", "Tulsa"], "572": ["OK", "Oklahoma City"], "580": ["OK", "rural OK"], "918": ["OK", "Tulsa"],
  // Oregon
  "458": ["OR", "Eugene / Bend / southern OR"], "503": ["OR", "Portland"], "541": ["OR", "Eugene / Bend / southern OR"], "971": ["OR", "Portland"],
  // Pennsylvania
  "215": ["PA", "Philadelphia"], "223": ["PA", "Harrisburg / Lancaster"], "267": ["PA", "Philadelphia"], "272": ["PA", "Scranton"], "412": ["PA", "Pittsburgh"], "445": ["PA", "Philadelphia"],
  "484": ["PA", "Allentown / Philly suburbs"], "570": ["PA", "Scranton / NE PA"], "582": ["PA", "Altoona / Erie"], "610": ["PA", "Allentown / Philly suburbs"], "717": ["PA", "Harrisburg / Lancaster"],
  "724": ["PA", "Pittsburgh suburbs"], "814": ["PA", "Altoona / Erie"], "835": ["PA", "Allentown / Philly suburbs"], "878": ["PA", "Pittsburgh"],
  // Rhode Island
  "401": ["RI"],
  // South Carolina
  "803": ["SC", "Columbia"], "839": ["SC", "Columbia"], "843": ["SC", "Charleston / Myrtle Beach"], "854": ["SC", "Charleston / Myrtle Beach"], "864": ["SC", "Greenville / Spartanburg"],
  // South Dakota
  "605": ["SD"],
  // Tennessee
  "423": ["TN", "Chattanooga / Tri-Cities"], "615": ["TN", "Nashville"], "629": ["TN", "Nashville"], "731": ["TN", "Jackson / west TN"], "865": ["TN", "Knoxville"], "901": ["TN", "Memphis"], "931": ["TN", "Clarksville / middle TN"],
  // Texas
  "210": ["TX", "San Antonio"], "214": ["TX", "Dallas"], "254": ["TX", "Waco / Killeen"], "281": ["TX", "Houston suburbs"], "325": ["TX", "Abilene / San Angelo"], "346": ["TX", "Houston"],
  "361": ["TX", "Corpus Christi"], "409": ["TX", "Beaumont / Galveston"], "430": ["TX", "Tyler / east TX"], "432": ["TX", "Midland / Odessa"], "469": ["TX", "Dallas"], "512": ["TX", "Austin"],
  "682": ["TX", "Fort Worth"], "713": ["TX", "Houston"], "726": ["TX", "San Antonio"], "737": ["TX", "Austin"], "806": ["TX", "Lubbock / Amarillo"], "817": ["TX", "Fort Worth"], "830": ["TX", "Hill Country / Kerrville"],
  "832": ["TX", "Houston"], "903": ["TX", "Tyler / east TX"], "915": ["TX", "El Paso"], "936": ["TX", "Conroe / east TX"], "940": ["TX", "Denton / Wichita Falls"], "945": ["TX", "Dallas"], "956": ["TX", "Rio Grande Valley / Laredo"], "972": ["TX", "Dallas suburbs"], "979": ["TX", "College Station"],
  // Utah
  "385": ["UT", "Salt Lake City"], "435": ["UT", "St. George / Moab / rural UT"], "801": ["UT", "Salt Lake City / Wasatch Front"],
  // Vermont
  "802": ["VT"],
  // Virginia
  "276": ["VA", "SW Virginia"], "434": ["VA", "Lynchburg / Charlottesville"], "540": ["VA", "Roanoke / Shenandoah"], "571": ["VA", "Northern VA"], "703": ["VA", "Northern VA"], "757": ["VA", "Norfolk / Virginia Beach"], "804": ["VA", "Richmond"], "826": ["VA", "Lynchburg / Charlottesville"], "948": ["VA", "Norfolk / Virginia Beach"],
  // Washington
  "206": ["WA", "Seattle"], "253": ["WA", "Tacoma"], "360": ["WA", "Olympia / Bellingham / Vancouver WA"], "425": ["WA", "Bellevue / Eastside"], "509": ["WA", "Spokane / Wenatchee / eastern WA"], "564": ["WA", "western WA"],
  // West Virginia
  "304": ["WV"], "681": ["WV"],
  // Wisconsin
  "262": ["WI", "Kenosha / Racine / Waukesha"], "274": ["WI", "Green Bay"], "353": ["WI", "Madison"], "414": ["WI", "Milwaukee"], "534": ["WI", "Eau Claire / northern WI"], "608": ["WI", "Madison"], "715": ["WI", "Eau Claire / northern WI"], "920": ["WI", "Green Bay / Appleton"],
  // Wyoming
  "307": ["WY"],
  // Canada
  "204": ["MB", "Winnipeg"], "226": ["ON", "London / SW Ontario"], "236": ["BC", "Vancouver"], "249": ["ON", "northern Ontario"], "250": ["BC", "Victoria / interior BC"], "263": ["QC", "Montreal"],
  "289": ["ON", "Hamilton / Niagara"], "306": ["SK"], "343": ["ON", "Ottawa"], "354": ["QC"], "365": ["ON", "Hamilton / Niagara"], "367": ["QC", "Quebec City"], "368": ["AB", "Calgary / Edmonton"],
  "382": ["ON", "London / SW Ontario"], "403": ["AB", "Calgary"], "416": ["ON", "Toronto"], "418": ["QC", "Quebec City"], "428": ["NB"], "431": ["MB", "Winnipeg"], "437": ["ON", "Toronto"],
  "438": ["QC", "Montreal"], "450": ["QC", "Montreal suburbs"], "468": ["QC"], "474": ["SK"], "506": ["NB"], "514": ["QC", "Montreal"], "519": ["ON", "London / SW Ontario"], "548": ["ON", "London / SW Ontario"],
  "579": ["QC", "Montreal suburbs"], "581": ["QC", "Quebec City"], "584": ["MB", "Winnipeg"], "587": ["AB", "Calgary / Edmonton"], "604": ["BC", "Vancouver"], "613": ["ON", "Ottawa"], "639": ["SK"],
  "647": ["ON", "Toronto"], "672": ["BC", "Vancouver"], "683": ["ON", "northern Ontario"], "705": ["ON", "northern Ontario"], "709": ["NL"], "742": ["ON", "Hamilton / Niagara"], "753": ["ON", "Ottawa"],
  "778": ["BC", "Vancouver / BC"], "780": ["AB", "Edmonton"], "782": ["NS"], "807": ["ON", "Thunder Bay"], "819": ["QC", "Gatineau / Sherbrooke"], "825": ["AB", "Calgary / Edmonton"], "867": ["YT"],
  "873": ["QC", "Gatineau / Sherbrooke"], "879": ["NL"], "902": ["NS", "Halifax"], "905": ["ON", "Hamilton / Niagara / GTA suburbs"], "942": ["ON", "Toronto"],
};

export interface PhoneLocation { areaCode: string; state: string; stateName: string; hint: string | null; country: "US" | "CA" }

/** Where a +1 number's area code points. Null for non-NANPA or unknown codes. */
export function locationFromPhone(e164: string | null | undefined): PhoneLocation | null {
  const digits = String(e164 ?? "").replace(/\D/g, "");
  const code = digits.length === 11 && digits.startsWith("1") ? digits.slice(1, 4) : digits.length === 10 ? digits.slice(0, 3) : null;
  if (!code) return null;
  const hit = CODES[code];
  if (!hit) return null;
  const [state, hint] = hit;
  const country: "US" | "CA" = ["AB", "BC", "MB", "NB", "NL", "NS", "ON", "PE", "QC", "SK", "NT", "YT", "NU"].includes(state) ? "CA" : "US";
  return { areaCode: code, state, stateName: S[state] ?? state, hint: hint ?? null, country };
}

/** Human line for AI context: "Denver / Boulder area, Colorado (from the 303 area code)". */
export function describePhoneLocation(loc: PhoneLocation | null): string | null {
  if (!loc) return null;
  return `${loc.hint ? `${loc.hint} area, ` : ""}${loc.stateName}${loc.country === "CA" ? ", Canada" : ""} (inferred from the ${loc.areaCode} area code; cell numbers can move, so treat as likely, not certain)`;
}
