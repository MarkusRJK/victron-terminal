
const Math = require('mathjs');
const request = require('request'); // FIXME: deprecated
var fs = require('fs');
const logger = require('log4js').getLogger();
const setDriftlessTimeout = require('driftless').setDriftlessTimeout;
const setDriftlessInterval = require('driftless').setDriftlessInterval;
const clearDriftless = require('driftless').clearDriftless;
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
    constructor(meter, lat, lon, apiKey) {
        logger.trace('PVInputFromIrradianceML::constructor');

        if(! PVInputFromIrradianceML.instance){
            this.UFlatitude = lat;
            this.UFlongitude = lon;
            this.UFapiKey = apiKey;
            this.temp = 0;
            this.AvgTemperature = 0;
            this.lastTime = 0;
            this.sunrise = 0;
            this.earliestTimeOfCurrent = 0;
            this.sunset = 0;
            this.latestTimeOfCurrent = 0;
            this.remoteToPCclk = 0;
            this.meter = meter;
            this.EDirectNormal      = 0; // needs to be multiplied with (1-clouds)
            this.EDiffuseHorizontal = 0; // needs to be multiplied with clouds
            this.nextForecastTimer = null;
            this.hourlyTimer = null;

            this.lastHour = this.meter.setStart();
            this.updateForecast();

            this.csv = fs.createWriteStream('/var/log/pv.log', {flags: 'a'});
            // FIXME: addd column pop
            this.csv.write('start time,\tDNI,\tDHI,\tdirectUse,\tabsorb.,\tloss1,\tloss2,\tclouds,\ttemp (' +
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
        logger.debug('earliestCurrent: ' + new Date(this.sunrise).toTimeString());
        return this.sunrise;
    }

    latestCurrent() {
        // FIXME: see above
        //return this.latestTimeOfCurrent;
        logger.debug('latestCurrent: ' + new Date(this.sunset).toTimeString());
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

    setTemp(temp, time) {
        logger.trace('PVInputFromIrradianceML::setTemp');
        this.temp = temp;
        this.addFlowAndTemp(time);
    }
    
    setFlow(chargerFlow, time) {
        logger.trace('PVInputFromIrradianceML::setFlow(.)');
        this.addFlowAndTemp(time);

        // morning before or after sunrise but before sunset
        // 0 < time < this.sunset ==> this.earliestTimeOfCurrent != 0
        if (time < this.sunset && chargerFlow.getCurrent() > 0)
            this.earliestTimeOfCurrent = Math.min(time, this.earliestTimeOfCurrent);
        if (time >= this.sunrise && chargerFlow.getCurrent() <= 0)
            this.latestTimeOfCurrent = Math.max(time, this.latestTimeOfCurrent);
    }

    persist(meterId) {
        logger.debug('PVInputFromIrradianceML::persist - writing data to CSV file');
        // write data to CSV: time, nominalI, nominalP
        let t = new Date(this.forecastStartTime).toTimeString().substring(0,8);

        this.csv.write(t + ',\t' +
                       (convMsToH * this.EDirectNormal * (1.0 - this.pcClouds)).toFixed(4) + ',\t' +
                       (convMsToH * this.EDiffuseHorizontal * this.pcClouds).toFixed(4) + ',\t' +
                       this.meter.getEDirectUse(meterId).toFixed(4) + ',\t' +
                       this.meter.getEAbsorbed(meterId).toFixed(4) + ',\t' +
                       this.meter.getELoss1(meterId).toFixed(4) + ',\t' +
                       this.meter.getELoss2(meterId).toFixed(4) + ',\t' +
                       this.pcClouds + ',\t' +
                       this.AvgTemperature / this.EDiffuseHorizontal + '\n');
    }

    addFlowAndTemp(time) {
        let doExit = false;
        if (!time) time = new Date();
        logger.trace('PVInputFromIrradianceML::addFlowAndTemp(' + time + ')');
        // time dependent processing:
        if (!this.sunset || !this.sunrise) {
            logger.debug('PVInputFromIrradianceML::addFlowAndTemp: sunrise or sunset not available');
            doExit = true;
        }
        if (time < this.sunrise || time > this.sunset) {
            //logger.info('PVInputFromIrradianceML::addFlowAndTemp: night time');
            doExit = true;
        }
        // if first call then set time only
        // if hour lapses then start new bucket
        if (this.lastTime === 0) {
            this.lastTime = time;
            logger.debug('PVInputFromIrradianceML::addFlowAndTemp: first time - skip flow');
            doExit = true; // skip this flow
        }
        if (doExit) return;

        let timeDiff = time - this.lastTime;

        this.AvgTemperature += this.temp * timeDiff; // needs to be divided by this.EDiffuseHorizontal

        // the timestamp weather.current.dt is between
        // hourly[0].dt and hourly[1].dt. If time goes beyond
        // hourly[1].dt then request a new forecast. 
        let s = Math.sin(this.scaleSunRiseAndSetToPI(time));
        let c = Math.abs(Math.cos(this.scaleSunRiseAndSetToPI(time)));
        // estimated energy from the direct normal and diffuse horizontal irradiance
        this.EDirectNormal      += s * timeDiff; // needs to be multiplied with (1-clouds)
        // FIXME: rename to something else as this should be 1 hour and reflects the error through incremental adds
        this.EDiffuseHorizontal += timeDiff;     // needs to be multiplied with clouds
        this.EDirectOrthogonal  += c * timeDiff; // needs to be multiplied with clouds

        // Model: collect DNI and DHI and meter data for one hour. The model 
        // multiplies DNI with the sun angle, DNI and DHI with the clouds coverage.
        // Direct used, battery absorbed and drawn currents are accumulated. Two
        // losses are estimated linear to the battery voltage and linear to the
        // PV voltage above the battery voltage. The following model allows for
        // linear combination. Basic idea:
        //
        // incoming energy = outgoing energy + losses
        //
        // DNI * EDirectNormal * (1-pcClouds) + DHI * EDiffuseHorizontal * pcClouds + Edrawn
        // = EDirectUse + EAbsorbed + a * ELoss1 + b * ELoss2 + c * ELoss3
        // ELoss3 = (temp - 20)!!! not really a loss but reduction - think!!!
        //
        // where DNI, DHI, a and b are unknowns and will be calculated with
        // linear regression:
        // FIXME: redo: add sin/cos/const DI, temp
        // [DNI DHI a b] * [EDirectNormal*(1-pcClouds)] 
        //                 [EDiffuseHorizontal*pcClouds] = EDirectUse + EAbsorbed - Edrawn
        //                 [-ELoss1]
        //                 [-ELoss2]

        this.lastTime = time;
    }

    terminate() {
        logger.debug('PVInputFromIrradianceML::terminate');
        // write remaining data to CSV
        let t = new Date(this.forecastStartTime).toTimeString().substring(0,8);

        this.csv.write('\nTotals:\n');
        this.persist();

        // FIXME: move to meter.js and fix it: eraliest is curently sunset nad latest is sunrise
        this.csv.write('\nearliest current at ' +
                       new Date(this.earliestTimeOfCurrent));
        this.csv.write('\nlatest current at ' +
                       new Date(this.latestTimeOfCurrent) + '\n');
    }

    updateForecast() {
        // 24 hours forecast, one array entry starting at each hour
        let url = `https://api.openweathermap.org/data/2.5/onecall?lat=${this.UFlatitude}&lon=${this.UFlongitude}&exclude=minutely,daily,alerts&units=metric&appid=${this.UFapiKey}`
        logger.debug('PVInputFromIrradianceML::updateForecast: ' + url);
        request(url, function (error, response, body) {
            if(error){
                logger.error('ERROR:', error);
            } else {
                logger.debug('body:', body);
                try {       
                    // if the parse fails, weather will remain with the old data
                    weather = JSON.parse(body);
                    logger.debug('received weather data from ' +
                                 new Date(weather.current.dt * 1000));
                    if (response) logger.debug('status code ' + response.statusCode);
                    solarState.setSunrise(weather.current.sunrise);
                    solarState.setSunset(weather.current.sunset);
                    //weather.hourly.map(h => console.log(new Date(h.dt * 1000).toTimeString().substring(0,8)));
                    this.copyWeatherData();
                    if (this.hourlyTimer === null) this.setupForecasts();
                    this.setRemoteToPCdiffTime();
                }
                catch(err) {
                    logger.error("ERROR: could not parse weather; ", err);
                }
            }
        }.bind(this));
    }

    setupForecasts() {
        logger.debug('PVInputFromIrradianceML::setupForecast');
        if (this.nextForecastTimer) clearDriftless(this.nextForecastTimer);
        if (this.hourlyTimer) clearDriftless(this.hourlyTimer);
        this.hourlyTimer = null;

        const now = new Date();
        if (now.getTime() > this.sunset) {
            // get sunrise and sunset for next day with midnight forecast
            // calculate next midnight plus 5 minutes
            const fiveMinInMs = 300000; // 5 * 60 * 1000;
            const timeToFivePastMidnight =
                  new Date(now.getFullYear(), now.getMonth(), now.getDate(),
                           23, 59, 59, 999).getTime() + fiveMinInMs - now.getTime();
            logger.debug("setting timer for midnight forecast at " + (new Date(timeToFivePastMidnight+now.getTime())).toTimeString());
            this.nextForecastTimer = setDriftlessTimeout(this.updateForecast.bind(this),
                                                         timeToFivePastMidnight);
            // past midnight the weather forecast will set the sunrise and sunset
            // for the new day, i.e. now < weather.current.sunrise < weather.current.sunset
        }
        else {
            let sunrise = new Date(this.sunrise);
            // 1 min past hour of the sunrise
            const sunriseHour =
                  new Date(sunrise.getFullYear(), sunrise.getMonth(), sunrise.getDate(),
                           sunrise.getHours(), 1, 0, 0).getTime();
            if (now.getTime() <= sunriseHour) {
                // get forecast at sunrise
                // calculate time till the hour of the sunrise plus one minute
                // e.g. sunrise at 4:30 => call setupForecasts at 4:01
                logger.debug("setting timer for sunrise forecast at " + (new Date(sunriseHour)).toTimeString() +
                             "; sunrise at " + (new Date(weather.current.sunrise * 1000)).toTimeString());
                this.nextForecastTimer = setDriftlessTimeout(this.updateForecast.bind(this),
                                                             sunriseHour - now.getTime());
            }
            else {
                // at daytime:
                // calculate next time to next full hour plus 1 minute
                const timeToOneMinPastNextHour =
                      new Date(now.getFullYear(), now.getMonth(), now.getDate(),
                               now.getHours() + 1, 1, 0, 0).getTime() - now.getTime();
                logger.debug("setting first hourly timer for " +
                             (new Date(timeToOneMinPastNextHour+now.getTime())).toTimeString());
                this.nextForecastTimer = setDriftlessTimeout(this.hourlyForecast.bind(this),
                                                             timeToOneMinPastNextHour);
            }
        }
    }

    hourlyForecast() {
        const oneHour = 3600000; // 1000 * 60 * 60;
        if (this.hourlyTimer === null) {
            logger.debug("setting hourly interval");
            this.hourlyTimer = setDriftlessInterval(this.hourlyForecast.bind(this), oneHour);
        }
        const now = new Date();
        if (now > this.sunrise && now < this.sunset) {
            this.persist(this.lastHour);
            this.lastHour = this.meter.setStart(this.lastHour);
            logger.debug('calling this.updateForecast();');
            this.updateForecast();
        }
        else {
            if (now >= this.sunset) {
                // stop forecasts after sunrise
                logger.debug('stop hourly forecasts');
                clearDriftless(this.hourlyTimer);
                this.hourlyTimer = null; // ensure setupForecasts is invoked by updateForecast
                this.updateForecast();
            }
        }
    };

}


module.exports.PVInputFromIrradianceML = PVInputFromIrradianceML;
module.exports.solarState = solarState;
