
const Math = require('mathjs');
const request = require('request'); // FIXME: deprecated
var fs = require('fs');
const logger = require('log4js').getLogger();
//const MLR = require('ml-regression-multivariate-linear');
//const mlr = new MLR();



// used in web app
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
const convMsToH = 1.0 / (1000 * 60 * 60);


class PVInputFromIrradianceML {

    // \param meter is a compulsory metering object
    constructor(meter) {
        logger.trace('PVInputFromIrradianceML::constructor');

        if(! PVInputFromIrradianceML.instance){
            this.lastU = null; // last voltage
            this.lastI = null; // last current
            this.lastTime = 0;
            this.sunrise = 0;
            this.earliestTimeOfCurrent = 0;
            this.sunset = 0;
            this.latestTimeOfCurrent = 0;
            this.remoteToPCclk = 0;
            this.meter = meter;
            this.EDirectNormal      = 0; // needs to be multiplied with (1-clouds)
            this.EDiffuseHorizontal = 0;     // needs to be multiplied with clouds
            this.lastHour = this.meter.setStart();
            
            // determine time difference of PC clock and weather clock
            this.setRemoteToPCdiffTime();
            // get weather reading
            this.copyWeatherData();

            // setTimeout(function () {
            //     this.addFlow();
            // }.bind(this), 60000); // every minute
            // FIXME: setTimeout to calculated next full hour minus 1minute
            //        and from there setInterval
            //setInterval(this.addFlow.bind(this), 60000); // every minute

            this.csv = fs.createWriteStream('/var/log/pv.log', {flags: 'a'});
            // FIXME: addd column pop
            this.csv.write('start time,\tDNI,\tDHI,\tdirectUse,\tabsorb.,\tloss,\tclouds (' +
                           new Date().toDateString() + ')\n');

            PVInputFromIrradianceML.instance = this;
            Object.freeze(PVInputFromIrradianceML);
        }
        return PVInputFromIrradianceML.instance;
    }

    // FIXME: better name 
    earliestCurrent() {
        // FIXME: earliest and latestTimeOfCurrent need better processing (lookback over
        //        10 days or so) until then use sunrise and sunset
        //        ALSO persistence with readback must be implemented!!!
        //return this.earliestTimeOfCurrent;
        return this.sunrise;
    }

    latestCurrent() {
        // FIXME: see above
        //return this.latestTimeOfCurrent;
        return this.sunset;
    }

    toPCclk(tInSec) {
        logger.trace('PVInputFromIrradianceML::toPCclk');
        return (tInSec * 1000 + this.remoteToPCclk);
    }

    copyWeatherData() {
        logger.debug('PVInputFromIrradianceML::copyWeatherData');
        this.requestTime = weather.current.dt * 1000;

        // sunrise is the sunrise of the current day (i.e. not the next day)
        this.sunrise           = this.toPCclk(weather.current.sunrise);
        this.latestTimeOfCurrent = this.sunrise;
        // sunset is the sunset of the current day
        this.sunset            = this.toPCclk(weather.current.sunset);
        this.earliestTimeOfCurrent = this.sunset;
        this.forecastStartTime = this.toPCclk(weather.hourly[0].dt);
        this.forecastEndTime   = this.toPCclk(weather.hourly[1].dt);
        // FIXME: rename to pcClouds
        this.pcClouds     = weather.hourly[0].clouds * 0.01;
    }

    // add this.remoteToPCclk to any remote time received from weather server
    setRemoteToPCdiffTime() {
        let weatherClock = weather.current.dt * 1000;
        let pcClock = new Date(); // current PC time and date
        this.remoteToPCclk = pcClock - weatherClock;
        logger.debug('PVInputFromIrradianceML::setRemoteToPCdiffTime is ' + this.remoteToPCclk);
    }

    // linear transformation to map the time between sunrise and sunset to [0; PI]
    scaleSunRiseAndSetToPI(t) {
        if (t <= this.sunrise || t >= this.sunset) return 0;
        let sd = this.sunset - this.sunrise; // sunny duration
        let a  = Math.PI / sd;
        let b  = -a * this.sunrise;
        return a * t + b;
    }

    setFlow(chargerFlow, pvVoltage, time) {
        logger.trace('PVInputFromIrradianceML::setFlow(.)');
        this.lastU = chargerFlow.getVoltage();
        this.lastI = chargerFlow.getCurrent();
        this.addFlow(time);

        // morning before or after sunrise but before sunset
        // 0 < time < this.sunset ==> this.earliestTimeOfCurrent != 0
        if (time < this.sunset && chargerFlow.getCurrent() > 0)
            this.earliestTimeOfCurrent = Math.min(time, this.earliestTimeOfCurrent);
        if (time >= this.sunrise && chargerFlow.getCurrent() <= 0)
            this.latestTimeOfCurrent = Math.max(time, this.latestTimeOfCurrent);
    }

    printTimes(time) {
        logger.debug('time: ' + new Date(time).toTimeString().substring(0,8));
        logger.debug('fcstart: ' + new Date(this.forecastStartTime).toTimeString().substring(0,8));
        logger.debug('fcend: ' + new Date(this.forecastEndTime).toTimeString().substring(0,8));
        logger.debug('wstart: ' + new Date(weather.hourly[0].dt*1000).toTimeString().substring(0,8));
        logger.debug('wend: ' + new Date(weather.hourly[1].dt*1000).toTimeString().substring(0,8));

    }

    addFlow(time) {
        let doExit = false;
        if (!time) time = new Date();
        logger.trace('PVInputFromIrradianceML::addFlow(' + time + ')');
        // wait until the first flow has come in
        if (this.lastU === null || this.lastI === null) {
            logger.debug('PVInputFromIrradianceML::addFlow: no flow available');
            doExit = true;
        }
        // time dependent processing:
        if (!this.sunset || !this.sunrise) {
            logger.debug('PVInputFromIrradianceML::addFlow: sunrise or sunset not available');
            doExit = true;
        }
        if (time < this.sunrise) {
            //logger.info('PVInputFromIrradianceML::addFlow: night time');
            // TODO: setTimeout for next updateForecast()
            doExit = true; // do not clock up limited requests to openweathermap
        }
        // if first call then set time only
        // if hour lapses then start new bucket
        if (this.lastTime === 0) {
            this.lastTime = time;
            logger.debug('PVInputFromIrradianceML::addFlow: first time - skip flow');
            doExit = true; // skip this flow
        }
        if (doExit) return;

        let timeDiff = time - this.lastTime;

        // time like weather.current.dt is between
        // hourly[0].dt and hourly[1].dt. If time goes beyond
        // hourly[1].dt then request a new forecast. 
        if (this.requestTime !== null) {
            if (time > this.forecastEndTime + 1000) {
                logger.debug('PVInputFromIrradianceML::addFlow: requesting forecast for next hour');

                //this.printTimes(time);
                
                this.requestTime = null; // mark that a request is on its way
                module.exports.updateForecast(); // FIXME: what if updateForecast fails

                //this.printTimes(time);
            }
            //logger.debug('PVInputFromIrradianceML::addFlow: accumulating 1');
            let s = Math.sin(this.scaleSunRiseAndSetToPI(time));
            // estimated energy from the direct normal and diffuse horizontal irradiance
            this.EDirectNormal      += s * timeDiff; // needs to be multiplied with (1-clouds)
            this.EDiffuseHorizontal += timeDiff;     // needs to be multiplied with clouds
        }
        else {
            if (time < this.toPCclk(weather.hourly[1].dt)) {

                //this.printTimes(time);

                logger.debug('PVInputFromIrradianceML::addFlow: writing data to CSV file');
                // write data to CSV: time, nominalI, nominalP
                let t = new Date(this.forecastStartTime).toTimeString().substring(0,8);

                this.csv.write(t + ',\t' +
                               (convMsToH * this.EDirectNormal * (1.0 - this.pcClouds)).toFixed(4) + ',\t' +
                               (convMsToH * this.EDiffuseHorizontal * this.pcClouds).toFixed(4) + ',\t' +
                               this.meter.getEDirectUse(this.lastHour).toFixed(4) + ',\t' +
                               this.meter.getEAbsorbed(this.lastHour).toFixed(4) + ',\t' +
                               this.meter.getELoss(this.lastHour).toFixed(4) + ',\t' +
                               this.pcClouds + '\n');

                this.copyWeatherData();

                //this.printTimes(time);

                this.lastHour = this.meter.setStart(this.lastHour);
                let s = Math.sin(this.scaleSunRiseAndSetToPI(time));
                // estimated energy from the direct normal and diffuse horizontal irradiance
                this.EDirectNormal      = s * timeDiff; // needs to be multiplied with (1-clouds)
                this.EDiffuseHorizontal = timeDiff;     // needs to be multiplied with clouds
            }
            else {
                //logger.debug('PVInputFromIrradianceML::addFlow: accumulating 2');
                let s = Math.sin(this.scaleSunRiseAndSetToPI(time));
                // estimated energy from the direct normal and diffuse horizontal irradiance
                this.EDirectNormal      += s * timeDiff; // needs to be multiplied with (1-clouds)
                this.EDiffuseHorizontal += timeDiff;     // needs to be multiplied with clouds
            }           
        }
        this.lastTime = time;
    }

    terminate() {
        logger.debug('PVInputFromIrradianceML::terminate');
        // write remaining data to CSV
        let t = new Date(this.forecastStartTime).toTimeString().substring(0,8);

        this.csv.write(t + ',\t' +
                       (convMsToH * this.EDirectNormal * (1.0 - this.pcClouds)).toFixed(4) + ',\t' +
                       (convMsToH * this.EDiffuseHorizontal * this.pcClouds).toFixed(4) + ',\t' +
                       this.meter.getEDirectUse().toFixed(4) + ',\t' +
                       this.meter.getEAbsorbed().toFixed(4) + ',\t' +
                       this.meter.getELoss().toFixed(4) + ',\t' +
                       this.pcClouds + '\n');

	// FIXME: incorrect - not giving totals...

        // this.csv.write('\nTotals:\n');
        // let now = new Date();
        // this.csv.write(t + ',\t' +
        //                (convMsToH * this.EDirectNormal * (1.0 - this.pcClouds)).toFixed(4) + ',\t' +
        //                (convMsToH * this.EDiffuseHorizontal * this.pcClouds).toFixed(4) + ',\t' +
        //                this.meter.getEDirectUse(now).toFixed(4) + ',\t' +
        //                this.meter.getEAbsorbed(now).toFixed(4) + ',\t' +
        //                this.meter.getELoss(now).toFixed(4) + ',\t' +
        //                this.pcClouds + '\n');

        this.csv.write('\nearliest current at ' +
                       new Date(this.earliestTimeOfCurrent));
        this.csv.write('\nlatest current at ' +
                       new Date(this.latestTimeOfCurrent) + '\n');
    }
}

var pvInput = null;
var UFapiKey = '';
var UFlatitude = -1;
var UFlongitude = -1;
var UFmeter = null;

module.exports.updateForecast = function(apiKey, lat, lon, meter) {
    if (apiKey) UFapiKey = apiKey;
    if (lat)    UFlatitude = lat;
    if (lon)    UFlongitude = lon;
    if (meter)  UFmeter = meter;
    // 24 hours forecast, one array entry starting at each hour
    let url = `https://api.openweathermap.org/data/2.5/onecall?lat=${UFlatitude}&lon=${UFlongitude}&exclude=minutely,daily,alerts&units=metric&appid=${UFapiKey}`
    logger.trace('updateForecast: ' + url);
    request(url, function (error, response, body) {
        if(error){
            logger.error('ERROR:', error);
        } else {
            //logger.debug('body:', body);
            try {       
                weather = JSON.parse(body);
                logger.debug('received weather data from ' +
                             new Date(weather.current.dt * 1000));
                if (response) logger.debug('status code ' + response.statusCode);
                solarState.setSunrise(weather.current.sunrise);
                solarState.setSunset(weather.current.sunset);
                //weather.hourly.map(h => console.log(new Date(h.dt * 1000).toTimeString().substring(0,8)));
                if (!pvInput || !UFmeter) pvInput = new PVInputFromIrradianceML(UFmeter);
                module.exports.pvInput = pvInput;
            }
            catch(err) {
                logger.error("ERROR: could not parse weather; ", err);
            }
        }
    });
}


module.exports.pvInput = pvInput;
module.exports.solarState = solarState;
