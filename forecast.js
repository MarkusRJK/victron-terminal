'use strict';

const Math = require('mathjs');
const request = require('request');
var fs = require('fs');
const logger = require('log4js').getLogger();

var log_stdout = process.stdout;

let apiKey = 'c02463890b91a002fb8709c1ca04987b';
let lat=53.4853;
let lon=-6.152;




class SolarAltitude {

    constructor() {
        console.log("SolarAltitude()");
        // FIXME: set the latest sunrise time and the earliest sunset
        //        time for the latitude on 21/12 as initialization
        this.sunrise = 0;
        this.sunset  = 0;
    }

    getSunrise() {
        return this.sunrise;
    }

    getSunset() {
        return this.sunset;
    }

    setSunrise(t) {
        this.sunrise = t;
        console.log("Sunrise: " + this.sunrise);
    }

    setSunset(t) {
        this.sunset = t;
        console.log("Sunset:  " + this.sunset);
    }
}

var solarState = new SolarAltitude();
let weather = null;

// get forecast every hour: 1000 * 60 * 60 = 3600000
const convMsToH = 1.0 / (1000 * 60 * 60)

class NominalPVInput {
    constructor() {
        logger.debug('NominalPVInput::constructor');
        this.nominalCinAMs = 0;
        this.nominalPinWMs = 0;
        this.lastU = null; // last voltage
        this.lastI = null; // last current
        this.lastTime = 0;
        this.sunrise = 0;
        this.sunset = 0;
        // get weather reading
        this.copyWeatherData();

        // setTimeout(function () {
        //     this.addFlow();
        // }.bind(this), 60000); // every minute
        setTimeout(this.addFlow.bind(this), 60000); // every minute

        this.csv = fs.createWriteStream('/var/log/pv.log', {flags: 'a'});
        this.csv.write('start time,I,P,tscale,clouds\n');
    }

    toPCclk(tInSec) {
        return tInSec * 1000 + this.remoteToPCclk;
    }

    copyWeatherData() {
        logger.debug('NominalPVInput::copyWeatherData');
        this.requestTime = weather.current.dt * 1000;
        // determine time difference of PC clock and weather clock
        this.setRemoteToPCdiffTime();
        this.sunrise           = this.toPCclk(weather.current.sunrise);
        this.sunset            = this.toPCclk(weather.current.sunset);
        this.forecastStartTime = this.toPCclk(weather.hourly[0].dt);
        this.forecastEndTime   = this.toPCclk(weather.hourly[1].dt);
        this.pvPenetration     = weather.hourly[0].clouds * 0.01;
    }

    // add this.remoteToPCclk to any remote time received from weather server
    setRemoteToPCdiffTime() {
        let weatherClock = this.requestTime;
        let pcClock = new Date(); // current PC time and date
        this.remoteToPCclk = pcClock - weatherClock;
        logger.debug('NominalPVInput::setRemoteToPCdiffTime is ' + this.remoteToPCclk);
    }

    // linear transformation to map the time between sunrise and sunset to [0; PI]
    scaleSunRiseAndSetToPI(t) {
        if (t <= this.sunrise || t >= this.sunset) return 0;
        let sd = this.sunset - this.sunrise; // sunny duration
        let a  = Math.PI / sd;
        let b  = -a * this.sunrise;
        return a * t + b;
    }

    setFlow(flow, time) {
        logger.trace('NominalPVInput::setFlow(.)');
        this.lastU = flow.getVoltage();
        this.lastI = flow.getCurrent();
        this.addFlow(time);
    }

    addFlow(time) {
        if (!time) time = new Date();
        logger.trace('NominalPVInput::addFlow(' + time + ')');
        // wait until the first flow has come in
        if (this.lastU === null || this.lastI === null) {
            logger.debug('NominalPVInput::addFlow: no flow available');
            return;
        }
        // time dependent processing:
        if (!this.sunset || !this.sunrise) return;
        if (time < this.sunrise) {
            logger.debug('NominalPVInput::addFlow: night time');
            // TODO: setTimeout for next updateForecast()
            return; // do not clock up limited requests to openweathermap
        }
        // if first call then set time only
        // if hour lapses then start new bucket
        if (this.lastTime === 0) {
            this.lastTime = time;
            logger.debug('NominalPVInput::addFlow: first time - skip flow');
            return; // skip this flow
        }
        // time like weather.current.dt is between
        // hourly[0].dt and hourly[1].dt. If time goes beyond
        // hourly[1].dt then request a new forecast. Allow 60
        // seconds for this forecast.
        if ((time >= this.forecastEndTime - 60000
             || time > this.sunset) &&
            this.requestTime !== null) {
            logger.debug('NominalPVInput::addFlow: requesting forecast for next hour');
            this.requestTime = null; // mark that a request is on its way
            updateForecast(); // FIXME: what if updateForecast fails
        }
        // scale I to what it would be at noon time (highest sun)
        let timescale = 1 / Math.sin(this.scaleSunRiseAndSetToPI(time));
        let nominalI = this.lastI * timescale;
        // scale I to what it would be if cloud penetration was 100%
        nominalI = nominalI / this.pvPenetration;
        let nominalP = this.lastU * nominalI;
        let timeDiff = time - this.lastTime;

        if (time >= this.forecastEndTime) {
            logger.debug('NominalPVInput::addFlow: writing data to CSV file');
            // write data to CSV: time, nominalI, nominalP
            let t = new Date(this.forecastStartTime).toTimeString();
            this.csv.write(t + ',' +
                           (this.nominalCinAMs * convMsToH) + ',' +
                           (this.nominalPinWMs * convMsToH) + ',' +
                           timescale + ',' +
                           this.pvPenetration +
                           '\n');
            this.copyWeatherData();
            this.nominalCinAMs = nominalI * timeDiff;
            this.nominalPinWMs = nominalP * timeDiff;
        }
        else {
            this.nominalCinAMs += nominalI * timeDiff;
            this.nominalPinWMs += nominalP * timeDiff;
        }
        this.lastTime = time;
    }
}

var pvInput = null;

function updateForecast() {
    logger.debug('updateForecast');
    // 24 hours forecast, one array entry starting at each hour
    let url = `https://api.openweathermap.org/data/2.5/onecall?lat=${lat}&lon=${lon}&exclude=minutely,daily,alerts&units=metric&appid=${apiKey}`
    request(url, function (error, response, body) {
        if(error){
            logger.error('ERROR:', error);
        } else {
            console.log('body:', body);
            try {       
                weather = JSON.parse(body);
                solarState.setSunrise(weather.current.sunrise);
                solarState.setSunset(weather.current.sunset);
                //weather.hourly.map(h => console.log(new Date(h.dt * 1000).toTimeString().substring(0,8)));
                if (!pvInput) pvInput = new NominalPVInput();
                module.exports.pvInput = pvInput;
            }
            catch(err) {
                logger.error("ERROR: could not parse weather; ", err);
            }
        }
    });
}

updateForecast();
//setInterval(updateForecast, 3600000);


module.exports.pvInput = pvInput;
module.exports.solarState = solarState;
