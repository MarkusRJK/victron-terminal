
const Math = require('mathjs');
var fs = require('fs');
const logger = require('log4js').getLogger();

const file = __dirname + '/meter.json';

// get forecast every hour: 1000 * 60 * 60 = 3600000
const convMsToH = 1.0 / (1000 * 60 * 60);


class EnergyAndChargeMeter {
    constructor() {
        logger.trace('EnergyAndChargeMeter::constructor');
        this.resetAccumulations();
        this.setFlows(0, 0, 0, 0, 0, 'OFF', 0);
        this.setStart();
    }

    resetAccumulations() {
        logger.debug('EnergyAndChargeMeter::resetAccumulations'); // FIXME: revert to trace
        // E = Energy: is in Watt milliseconds - needs to be converted to Wh
        this.E = {
            directUse:   0,
            absorbed:    0,
            drawn:       0,
            loss:        0,
        }
        // C = capacity: is in Ampere milliseconds - needs to be converted to Ah
        this.C = {
            AMsAbsorbed: 0,
            AMsDrawn:    0,
        }
    }

    // \detail while the meter continues counting this function remembers the
    //         current meters and subtracts this reading in any of the get-ters
    setStart() {
        logger.debug('EnergyAndChargeMeter::setStart'); // FIXME: revert to trace
        // E = Energy: is in Watt milliseconds - needs to be converted to Wh
        this.Estart = {
            directUse:   this.E.directUse,
            absorbed:    this.E.absorbed,
            drawn:       this.E.drawn,
            loss:        this.E.loss,
        }
        // C = capacity: is in Ampere milliseconds - needs to be converted to Ah
        this.Cstart = {
            AMsAbsorbed: this.C.AMsAbsorbed,
            AMsDrawn:    this.C.AMsDrawn,
        }
    }

    setFlows(UPv, UBat, IPv, ILoad, IBat, relayState, time) {
        logger.trace('EnergyAndChargeMeter::setFlows');
        this.UPv   = UPv;
        this.UBat  = UBat;
        this.IPv   = IPv;
        this.ILoad = ILoad;
        this.IBat  = IBat;
        
        if (time !== 0) this.accumulate(relayState, time);
        
        this.lastTime = time;
    }   

    accumulate(relayState, time) {
        logger.trace('EnergyAndChargeMeter::accumulate');
        if (!this.lastTime) {
            this.lastTime = time;
            logger.debug('EnergyAndChargeMeter::accumulate: skip first time');
            return;
        }
        let timeDiff = time - this.lastTime;
        
        // E = Energy
        let C = this.IBat * timeDiff;
        if (this.IBat > 0) { // charging
            // FIXME: for correct metering determine whether ILoad is contained in IPv?
            //        it appears IPv = ILoad + IBat (no load on battery)
            if (relayState === 'ON')
                this.E.directUse   += this.UBat * (this.IPv - this.ILoad - this.IBat) * timeDiff;
            else
                this.E.directUse   += this.UBat * (-this.ILoad) * timeDiff;
            this.C.AMsAbsorbed += C; // absorbed ampere hours / convMsToH
            this.E.absorbed    += this.UBat * C; // absorbed energy / convMsToH
            this.E.loss        += Math.max(0, this.UPv - this.UBat) * C;
        } else {
            this.E.directUse   += this.UBat * this.IPv * timeDiff;
            this.C.AMsDrawn    += -C; // drawn ampere hours / convMsToH
            this.E.drawn       += -this.UBat * C; // drawn energy / convMsToH
        }
        // logger.debug(this.E.directUse + ' ' + this.E.absorbed  + ' ' + this.E.drawn +
        //           ' ' + this.E.loss + ' ' +
        //           this.C.AMsAbsorbed  + ' ' + this.C.AMsDrawn);
    }

    // all getE in Wh
    // \param total if true then all ever recorded energy since last reset is returned
    getEDirectUse(time) {
        let subtract = 0;
        let timeDiff = 0;
        if (time) {
            subtract = this.Estart.directUse;
            timeDiff = time - this.lastTime;
        }
        else timeDiff = new Date() - this.lastTime;
        return (this.E.directUse - subtract +
                this.UBat * (this.IPv - this.ILoad - Math.max(0, this.IBat)) * timeDiff)*convMsToH;
    }
    getEAbsorbed(time) {
        let subtract = 0;
        let timeDiff = 0;
        if (time) {
            subtract = this.Estart.absorbed;
            timeDiff = time - this.lastTime;
        }
        else timeDiff = new Date() - this.lastTime;
        return (this.E.absorbed - subtract + 
                this.UBat * Math.max(0, this.IBat) * timeDiff) * convMsToH;
    }
    getEDrawn(time) {
        let subtract = 0;
        let timeDiff = 0;
        if (time) {
            subtract = this.Estart.drawn;
            timeDiff = time - this.lastTime;
        }
        else timeDiff = new Date() - this.lastTime;
        return (this.E.drawn - subtract -
                this.UBat * Math.min(0, this.IBat) * timeDiff)* convMsToH;
    }
    // convert Energy to Euro in IRL
    toEuroInclVAT(energyInWh) {
        //                  to kWh  to Euro  +VAT
        return energyInWh * 0.001 * 0.1604 * 1.135;
    }
    getELoss(time) {
        let subtract = 0;
        let timeDiff = 0;
        if (time) {
            subtract = this.Estart.loss;
            timeDiff = time - this.lastTime;
        }
        else timeDiff = new Date() - this.lastTime;
        return (this.E.loss - subtract +
                (this.UPv - this.UBat) * Math.min(0, this.IBat) * timeDiff) * convMsToH;
    }

    // all getC in Ah
    getCAbsorbed(time) {
        let subtract = 0;
        let timeDiff = 0;
        if (time) {
            subtract = this.Cstart.AMsAbsorbed;
            timeDiff = time - this.lastTime;
        }
        else timeDiff = new Date() - this.lastTime;
        return (this.C.AMsAbsorbed - subtract +
                Math.max(0, this.IBat) * timeDiff) * convMsToH;
    }
    getCDrawn(time) {
        let subtract = 0;
        let timeDiff = 0;
        if (time) {
            subtract = this.Cstart.AMsDrawn;
            timeDiff = time - this.lastTime;
        }
        else timeDiff = new Date() - this.lastTime;
        return (this.C.AMsDrawn - subtract -
                Math.min(0, this.IBat) * timeDiff) * convMsToH;
    }

    writeData() {
        logger.debug('EnergyAndChargeMeter::writeData');
        let data = {
            time:         new Date(),
            directUse:    this.getEDirectUse(),
            absorbed:     this.getEAbsorbed(),
            drawn:        this.getEDrawn(),
            loss:         this.getELoss(),

            AhAbsorbed:   this.getCAbsorbed(),
            AhDrawn:      this.getCDrawn(),

            kWhHarvested: this.toEuroInclVAT(this.getEDirectUse() + this.getEDrawn())
        };
        let jData = JSON.stringify(data);
        logger.debug('Writing meter data to file ' + file);
        let meterFile = fs.createWriteStream(file, {flags: 'w'});
        meterFile.write(jData);
    }

    terminate() {
        logger.debug('EnergyAndChargeMeter::terminate');
	this.writeData();
    }
}

var meter = new EnergyAndChargeMeter();
const fiveMinutes = 1000 * 60 * 5;
setInterval(meter.writeData.bind(meter), fiveMinutes);

module.exports.EnergyAndChargeMeter = meter;
