
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
        this.EWMs = {
            directUse: 0,
            absorbed:  0,
            drawn:     0,
            loss:      0,
        }
        // C = capacity: is in Ampere milliseconds - needs to be converted to Ah
        this.CAMs = {
            absorbed:  0,
            drawn:     0,
        }
    }

    // \detail while the meter continues counting this function remembers the
    //         current meters and subtracts this reading in any of the get-ters
    setStart() {
        logger.debug('EnergyAndChargeMeter::setStart'); // FIXME: revert to trace
        // E = Energy: is in Watt milliseconds - needs to be converted to Wh
        this.EWMsStart = {
            directUse: this.EWMs.directUse,
            absorbed:  this.EWMs.absorbed,
            drawn:     this.EWMs.drawn,
            loss:      this.EWMs.loss,
        }
        // C = capacity: is in Ampere milliseconds - needs to be converted to Ah
        this.CAMsStart = {
            absorbed:  this.CAMs.absorbed,
            drawn:     this.CAMs.drawn,
        }
    }

    setFlows(UPv, UBat, IPv, ILoad, IBat, relayState, time) {
        logger.trace('EnergyAndChargeMeter::setFlows');
        this.UPv    = UPv;
        this.UBat   = UBat;
        this.IPv    = IPv;
        this.ILoad  = ILoad;
        this.IBat   = IBat;
        this.RState = relayState;
        
        if (time !== 0) this.accumulate(time);
        
        this.lastTime = time;
    }   

    accumulate(time) {
        logger.trace('EnergyAndChargeMeter::accumulate');
        if (!this.lastTime) {
            this.lastTime = time;
            logger.debug('EnergyAndChargeMeter::accumulate: skip first time');
            return;
        }
        let timeDiff = time - this.lastTime;
        
        // E = Energy
        let C = this.IBat * timeDiff;
        // IBat > 0 ==> laden, IPv >= 0, all U* >= 0, ILoad <= 0
        // logger.debug(this.IBat + ' ' + this.UBat  + ' ' + this.IPv +
        //           ' ' + this.UPv + ' ' +
        //           this.ILoad  + ' ' + timeDiff);
        if (this.IBat > 0) { // charging
            // FIXME: for correct metering determine whether ILoad is contained in IPv?
            //        it appears IPv = ILoad + IBat (no load on battery), load is negative!!!
            if (this.RState === 'ON')
                this.EWMs.directUse += this.UBat * (this.IPv - this.ILoad - this.IBat) * timeDiff;
            else
                this.EWMs.directUse += this.UBat * (-this.ILoad) * timeDiff;
            this.CAMs.absorbed      += C;
            this.EWMs.absorbed      += this.UBat * C;
            // IBat > 0 => UPv >= UBat
            this.EWMs.loss          += Math.max(0, this.UPv - this.UBat) * C;
        } else {
            if (this.RState === 'ON')
                this.EWMs.directUse += this.UBat * this.IPv * timeDiff;
            this.CAMs.drawn         += -C; // drawn ampere hours / convMsToH
            this.EWMs.drawn         += -this.UBat * C; // drawn energy / convMsToH
        }
        // logger.debug(this.EWMs.directUse + ' ' + this.EWMs.absorbed  + ' ' + this.EWMs.drawn +
        //           ' ' + this.EWMs.loss + ' ' +
        //           this.CAMs.absorbed  + ' ' + this.CAMs.drawn);
    }

    // all getE in Wh
    // \param total if true then all ever recorded energy since last reset is returned
    getEDirectUse(time) {
        let subtract = 0;
        let timeDiff = 0;
        if (time) {
            subtract = this.EWMsStart.directUse;
            timeDiff = time - this.lastTime;
        }
        else timeDiff = new Date() - this.lastTime;
        return (this.EWMs.directUse - subtract +
                this.UBat * (this.IPv - this.ILoad - Math.max(0, this.IBat)) * timeDiff)*convMsToH;
    }
    getEAbsorbed(time) {
        let subtract = 0;
        let timeDiff = 0;
        if (time) {
            subtract = this.EWMsStart.absorbed;
            timeDiff = time - this.lastTime;
        }
        else timeDiff = new Date() - this.lastTime;
        return (this.EWMs.absorbed - subtract + 
                this.UBat * Math.max(0, this.IBat) * timeDiff) * convMsToH;
    }
    getEDrawn(time) {
        let subtract = 0;
        let timeDiff = 0;
        if (time) {
            subtract = this.EWMsStart.drawn;
            timeDiff = time - this.lastTime;
        }
        else timeDiff = new Date() - this.lastTime;
        return (this.EWMs.drawn - subtract -
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
            subtract = this.EWMsStart.loss;
            timeDiff = time - this.lastTime;
        }
        else timeDiff = new Date() - this.lastTime;
        return (this.EWMs.loss - subtract +
                (this.UPv - this.UBat) * Math.min(0, this.IBat) * timeDiff) * convMsToH;
    }

    // all getC in Ah
    getCAbsorbed(time) {
        let subtract = 0;
        let timeDiff = 0;
        if (time) {
            subtract = this.CAMsStart.absorbed;
            timeDiff = time - this.lastTime;
        }
        else timeDiff = new Date() - this.lastTime;
        return (this.CAMs.absorbed - subtract +
                Math.max(0, this.IBat) * timeDiff) * convMsToH;
    }
    getCDrawn(time) {
        let subtract = 0;
        let timeDiff = 0;
        if (time) {
            subtract = this.CAMsStart.drawn;
            timeDiff = time - this.lastTime;
        }
        else timeDiff = new Date() - this.lastTime;
        return (this.CAMs.drawn - subtract -
                Math.min(0, this.IBat) * timeDiff) * convMsToH;
    }

    writeData() {
        logger.debug('EnergyAndChargeMeter::writeData');
        // TODO: use parseFloat when reading as toFixed outputs strings
        let data = {
            time:         new Date(),
            directUse:    this.getEDirectUse().toFixed(4),
            absorbed:     this.getEAbsorbed().toFixed(4),
            drawn:        this.getEDrawn().toFixed(4),
            loss:         this.getELoss().toFixed(4),

            AhAbsorbed:   this.getCAbsorbed().toFixed(4),
            AhDrawn:      this.getCDrawn().toFixed(4),

            kWhHarvested: this.toEuroInclVAT(this.getEDirectUse() + this.getEDrawn()).toFixed(2),
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
