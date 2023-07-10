/*
* Copyright 2023 Marcus Rejas
*
* Some code and inspiration is from signalk-mqtt-gw
* Copyright 2016 Teppo Kurki <teppo.kurki@iki.fi>
*
* But the mistakes are mine :-)
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
* http://www.apache.org/licenses/LICENSE-2.0

* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

const id = 'signalk-marinwiki';
const axios = require('axios')
const os = require("os");
var fs = require('fs');
var lastpos = { "lat": 0, "lng": 0 };
var route;

function bumpRoute() {
	route = Math.floor(Date.now() / 1000);
}

function log_to_file(message) {
	console.log("File logging disabled\n")
}

function sendToMarinwiki(config, mdata) {
	console.log('sendToMarinwiki called'); 
	var url = 'https://marinwiki.se/rest/pos/report.php';
	var data = new FormData();
	data.append('lat', mdata.lat);
	data.append('lng', mdata.lng);
	data.append('acc', 0); // Accuracy
	data.append('speed', mdata.speed);
	data.append('time', mdata.time);
	data.append('course', mdata.course);
	data.append('key', config.password);
	data.append('rid', mdata.route);
	data.append('provider', 'signalk-marinwiki');
	data.append('cached', false);

	var options = {
		uri: url,
		method: 'POST',
		data : data
	};

	axios
		.post(url, data)
		.then(res => {
			console.log(`Status: ${res.status}`)
    			console.log('Body: ', res.data)
			if (res.data != 'OK') {
				addToCache(mdata);
				console.log('Sending to Marinwiki failed, caching');
			} else {
				removeFromCache(mdata);
				console.log('Sending to Marinwiki succeded');
			}
  		})
  		.catch(err => {
    			console.error(err)
  		})
}

function radsToDeg(radians) {
	return radians * 180 / Math.PI;
}

function mpsToKn(mps) {
	return 1.9438444924574 * mps;
}

function distance(pos1, pos2) {
	const R = 6371e3; // metres
	const P1 = pos1.lat * Math.PI/180; // φ, λ in radians
	const P2 = pos2.lat * Math.PI/180;
	const DP = (pos2.lat-pos1.lat) * Math.PI/180;
	const DL = (pos2.lng-pos1.lng) * Math.PI/180;

	const a = Math.sin(DP/2) * Math.sin(DP/2) +
		Math.cos(P1) * Math.cos(P2) *
		Math.sin(DL/2) * Math.sin(DL/2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

	const distance = R * c; // in metres

	return(distance);
}

function addToCache(data) {
	console.log('In cache: ' + JSON.stringify(data));
	let dir = os.homedir() + '/.marinwiki.cache';

	if (data.cached === true) {
		return; // Already cached
	}

	data.cached = true;

	fs.writeFile(dir + '/' + data.time, JSON.stringify(data), err => {
		if (err) {
    			console.error(err);
  		}
	});
}

function removeFromCache(data) {
	console.log('In removeFromcache: ' + JSON.stringify(data));
	let dir = os.homedir() + '/.marinwiki.cache';

	if ( data.cached !== true ) {
		return;
	}

	fs.unlink(dir + '/' + data.time, (err) => {
  		if (err) {
    			console.error(err)
    			return
  		}

  		//file removed
	})
}


function flushCache(config) {
	//console.log('In flushCache');
	let dir = os.homedir() + '/.marinwiki.cache';

	fs.readdirSync(dir).map(fileName => {
		console.log('Found cache: ' + fileName);
		fs.readFile(dir + '/' + fileName, 'utf8', (err, data) => {
			if (err) {
    				console.error(err);
    				return;
  			}
			console.log('Found cache data: ' + data);
  			sendToMarinwiki(config, JSON.parse(data));
		});
  		return;
	});

}

module.exports = function(app) {
	var plugin = {
		unsubscribes: [],
	};
	
	plugin.id = id;
	plugin.name = 'SignalK to Marinwiki';
	plugin.description =
		'Plugin that sends position data to Marinwiki.';

	plugin.schema = {
		title: 'Signal K - Marinwiki',
		type: 'object',
		properties: {
			password: {
				type: "string",
				title: "API key from Marinwiki"
			},
		},
	};

	var started = false;

	plugin.onStop = [];

	plugin.start = function(options) {
		plugin.onStop = [];
		
		//setInterval( function() { startSending(options, plugin.onStop); }, 1000);
	
		// Make sure dir exists
		var dir = os.homedir() + '/.marinwiki.cache';

		if (!fs.existsSync(dir)){
			fs.mkdirSync(dir);
		}

		bumpRoute();

		startSending(options, plugin.onStop);

		setInterval( function() { flushCache(options); }, 60000);

		started = true;
	};

	plugin.stop = function() {
		plugin.onStop.forEach(f => f());
	};

	plugin.statusMessage = function () {
		if (started)
			return 'Sending to Marinwiki.';
		else
			return 'Waiting for connection to Marinwiki';
	}

	function startSending(options, onStop) {
		var position = app.getSelfPath('navigation.position');
		var speed = app.getSelfPath('navigation.speedOverGround');
		var course = app.getSelfPath('navigation.courseOverGroundTrue');

		var pos = {
			'lat' : position?.value.latitude ?? null,
			'lng' : position?.value.longitude ?? null,
			'time' : Date.parse(position?.timestamp ?? 0) / 1000
		} 

		app.debug("Date: " + pos.time);

		if ( pos.lat === null || pos.lng === null ) {
			console.log("Error in position, rescedule in 10s");
			setTimeout(function() { startSending(options, plugin.onStop); }, 10000);
			return
		
		}

		if (distance(pos, lastpos) < 10) {
			app.debug("Have not moved, rescedule in 30s (" + distance(pos, lastpos) + "m)");
			bumpRoute();
			setTimeout(function() { startSending(options, plugin.onStop); }, 30000);
			return
		} else {
			app.debug("Have moved (" + distance(pos, lastpos) + "m)");
		}

		// We have moved
		lastpos = pos;

		var mw_data = {
			'lat' : position?.value.latitude ?? null,
			'lng' : position?.value.longitude ?? null,
			'speed' : speed?.value ?? null,
			'course' : course?.value ?? null,
			'time' : Date.parse(position?.timestamp ?? 0) / 1000,
			'route' : route
		}

		// Send to marinwiki
		sendToMarinwiki(options, mw_data);

		if (mw_data.speed > 4) { 
			setTimeout(function() { startSending(options, plugin.onStop); }, 10000);
		} else {
			setTimeout(function() { startSending(options, plugin.onStop); }, 30000);
		}
	}


	return plugin;
};
