
const Math = require('mathjs');
var fs = require('fs');
const logger = require('log4js').getLogger();

const file = __dirname + '/meter.json';

// get forecast every hour: 1000 * 60 * 60 = 3600000
const convMsToH = 1.0 / (1000 * 60 * 60);


// \detail A metering object that stores several intermediate sets of start points.
//         Internally the meter counts continuously but sets a new starting point
//         on every call of setStart(). SetStart returns a reference which can be
//         used to overwrite the start point of that reference. E.g. for an hourly
//         counter call 'hourly = setStart(hourly);' setStart without a parameter
//         creates a new reference to a start point.
class Meter {
    constructor() {
        logger.trace('Meter::constructor');

        this.MeterStarts = new Map();
        this.start = 0;
    }

    // \detail while the meter continues counting this function remembers the
    //         current meters and subtracts this reading in any of the get-ters
    // \param  index of meter to reset start, if missing a new meter is generated
    // \return index of meter
    setStart(index) {
        logger.debug('Meter::setStart');
        let i = this.start;
        // if index ==> change existing start of a counter
        if (typeof index !== 'undefined' && index !== null &&
            (this.MeterStarts.has(index))) i = index;
        else ++this.start;

        let start = this.getObjectClone();
        this.MeterStarts.set(i, start); // replace existing
        return i;
    }

    // abstract: overwrite this method!
    getObjectClone() {
        logger.debug('Meter::getObjectClone'); // FIXME: revert to trace
        return {}; // e.g.
        // return {
        //     directUse:  this.EWMs.directUse,
        //     lowVoltUse: this.EWMs.lowVoltUse,
        //     useWhileOn: this.EWMs.useWhileOn,
        //     absorbed:   this.EWMs.absorbed,
        //     drawn:      this.EWMs.drawn,
        //     loss1:      this.EWMs.loss1,
        //     loss2:      this.EWMs.loss2
        // };
    }
}


// \class EnergyAndChargeMeter (singleton)
class EnergyAndChargeMeter extends Meter {
    constructor() {
        super();
        logger.trace('EnergyAndChargeMeter::constructor');

        if(! EnergyAndChargeMeter.instance){
            this.resetAccumulations();
            this.readData();
            this.setFlows(0, 0, 0, 0, 0, 'OFF', 0);
            this.start = 0;

            EnergyAndChargeMeter.instance = this;
            Object.freeze(EnergyAndChargeMeter);
        }
        return EnergyAndChargeMeter.instance;
    }

    resetAccumulations() {
        logger.trace('EnergyAndChargeMeter::resetAccumulations');
        this.meter = {
            // E = Energy: is in Watt milliseconds - needs to be converted to Wh
            // lowVoltUse is fully contained in directUse but recorded
            // separate as a constant draw of energy
            EWMs: {
                // energy used directly from panels
                directUse:  0,
                // energy used round the clock directly from the MPPT charger
                lowVoltUse: 0,
                // energy used by household during the time the relay is ON.
                // The total energy used by the household can only measured
                // while the relay is on
                useWhileOn: 0,
                // energy absorbed from the battery
                absorbed:   0,
                // energy drawn from the battery
                drawn:      0,
                // energy loss related to MPPT charger e.g. when battery is
                // full and MPPT has to burn energy
                loss1:      0,
                // energy loss related to charge and discharge of batteries
                loss2:      0
            },
            // C = capacity: is in Ampere milliseconds - needs to be converted to Ah
            CAMs: {
                absorbed:   0,
                drawn:      0
            }
        }
    }

    getObjectClone() {
        logger.debug('EnergyAndChargeMeter::getObjectClone'); // FIXME: revert to trace
        return {
            EWMs: {
                directUse:  this.meter.EWMs.directUse,
                lowVoltUse: this.meter.EWMs.lowVoltUse,
                useWhileOn: this.meter.EWMs.useWhileOn,
                absorbed:   this.meter.EWMs.absorbed,
                drawn:      this.meter.EWMs.drawn,
                loss1:      this.meter.EWMs.loss1,
                loss2:      this.meter.EWMs.loss2
            },
            CAMs: {
                absorbed:   this.meter.CAMs.absorbed,
                drawn:      this.meter.CAMs.drawn
            }  
        };
    }

    setFlows(UPv, UBat, IPv, ILoad, IBat, relayState, time) {
        logger.trace('EnergyAndChargeMeter::setFlows ' +
                    UPv + ' ' + UBat + ' ' + IPv + ' ' + ILoad + ' ' + IBat + ' ' + relayState);
        try {
            this.UPv    = UPv;
            this.UBat   = UBat;
            this.IPv    = IPv;
            this.ILoad  = ILoad;
            this.IBat   = IBat;
            this.RState = relayState;
            
            if (time !== 0) this.accumulate(time);
            
            this.lastTime = time;
        }
        catch(err) {
            logger.error('EnergyAndChargeMeter::setFlows failed: ' + err);
        }
    }   

    accumulate(time) {
        logger.trace('EnergyAndChargeMeter::accumulate');
        if (!this.lastTime) {
            this.lastTime = time;
            logger.info('EnergyAndChargeMeter::accumulate: skip first time');
            return;
        }
        let timeDiff = time - this.lastTime;
        
        // E = Energy
        this.meter.EWMs.lowVoltUse += -this.UBat * this.ILoad * timeDiff;
        // logger.debug(this.IBat + ' ' + this.UBat  + ' ' + this.IPv +
        //           ' ' + this.UPv + ' ' +
        //           this.ILoad  + ' ' + timeDiff);

        // constant MPPT load is approx 0.5Ah
        // constant house usage 8Ah (240V only without MPPT load)

        // The operation of the MPPT was not clear in terms of how the currents add
        // up. Here some operational situations:
        //
        // Env. = Environment, Relay = Relay state, MPPT PV = photovoltaic voltage
        // MPPT CV = MPPT Battery voltage
        // MPPT Cu = MPPT charge current (incl. load on battery e.g. dishwasher)
        // MPPT LD = MPPT Load current
        // BMV Cu  = BMV charge/load current
        // DT = Day time
        //
        // Env.      Relay   MPPT PV   MPPT CV   MPPT Cu   MPPT LD   BMV Cu   Comment
        // --------+-------+---------+---------+---------+---------+--------+---------------
        // Sun       ON      29.35V    25.41V    14.25A    0.30A     -57.5A   Diswasher
        // DT Rain   OFF     30.10V    26.70V     4.30A    0.75A       3.5A   vgl. next line
        // DT Rain   OFF     29.60V    26.40V     4.20A    4.30A       0.0A   full MPPT load
        // Late Eve  OFF     15.00V               0.00A    4.00A      -4.0A   full MPPT load
        //
        // Consequence:
        // Relay OFF: MPPT Cu = MPPT LD + BMV Cu, MPPT Cu >= 0, MPPT LD >= 0 for positive
        //            and negative BMV Cu
        // Relay ON:  the equation of the line above remains but additional current
        //            BMV DU flows in/out of the battery "seen" by MPPT as charge current
        //           
        //            BMV Cu > 0: MPPT Cu = MPPT LD + BMV Cu + BMV DU
        //                        ==> directUse = MPPT Cu - BMV Cu
        //            BMV Cu < 0: supply currents  = outgoing currents
        //                        MPPT Cu - BMV Cu = MPPT LD + BMV Use
        //                        ==> directUse = MPPT Cu
        // IBat    RState  directUse       absorbed  drawn  loss1            loss2
        // <= 0 && off:    min(IPv,ILoad)  0         IBat   0                UBat * IBat
        // <= 0 && on:     IPv             0         IBat   0                UBat * IBat
        // > 0  && off:    min(IPv,ILoad)  IBat      0      (UPv-UBat)*IBat  UBat * IBat
        // > 0  && on:     IPv-IBat        IBat      0      (UPv-UBat)*IBat  UBat * IBat
        let C      = this.IBat * timeDiff;
        let IBat   = this.IBat;
        let Edrawn = this.UBat * C;
        if (this.IBat > 0) { // charging
            this.meter.CAMs.absorbed      += C;
            this.meter.EWMs.absorbed      += Edrawn;
            // IBat > 0 => UPv >= UBat
            this.meter.EWMs.loss1         += Math.max(0, this.UPv - this.UBat) * C;
            this.meter.EWMs.loss2         += Edrawn;
        } else {
            IBat = 0;
            this.meter.CAMs.drawn         += -C; // drawn ampere hours / convMsToH
            this.meter.EWMs.drawn         += -Edrawn; // drawn energy / convMsToH
            this.meter.EWMs.loss2         += -Edrawn;
        }
        // IPv occasionally becomes negative when the MPPT charger blocks discharge
        // over PV panels too late or discharges on purpose over PV panels
        if (this.IPv < 0) this.meter.EWMs.loss1 = -this.UPv - this.IPv * timeDiff;
        let IPv = Math.max(this.IPv, 0);

        if (this.RState === 'ON') {
            let EdirectUse = this.UBat * (this.IPv - IBat) * timeDiff;
            this.meter.EWMs.directUse  += EdirectUse;
            this.meter.EWMs.useWhileOn += EdirectUse - Edrawn;
        }
        else
            this.meter.EWMs.directUse += this.UBat * Math.min(this.IPv,-this.ILoad) * timeDiff;
        // logger.debug(this.meter.EWMs.directUse + ' ' + this.meter.EWMs.absorbed  + ' ' + this.meter.EWMs.drawn +
        //           ' ' + this.meter.EWMs.loss1 + ' ' + this.meter.EWMs.loss2 + ' ' +
        //           this.meter.CAMs.absorbed  + ' ' + this.meter.CAMs.drawn);
    }

    // all getE in Wh
    // \param index specifies the meter to be returned, if no index returns the entire acc.
    // \see   setStart
    getEDirectUse(index) {
        let timeDiff = Date.now() - this.lastTime;
        let subtract = 0;
        if (typeof index !== 'undefined' && index !== null &&
            (this.MeterStarts.has(index))) subtract = this.MeterStarts.get(index).EWMs.directUse;
        else if (typeof index !== 'undefined')
            logger.fatal('EnergyAndChargeMeter has no index ' + index);

        let directUseLastMinutes = 0;
        let IBat = (this.IBat > 0 ? this.IBat : 0);

        if (this.RState === 'ON')
            directUseLastMinutes = this.UBat * (this.IPv - IBat) * timeDiff;
        else
            directUseLastMinutes = this.UBat * Math.min(this.IPv,-this.ILoad) * timeDiff;

        return (this.meter.EWMs.directUse - subtract + directUseLastMinutes) * convMsToH;
    }
    getELowVoltUse(index) {
        let timeDiff = Date.now() - this.lastTime;
        let subtract = 0;
        if (typeof index !== 'undefined' && index !== null &&
            (this.MeterStarts.has(index))) subtract = this.MeterStarts.get(index).EWMs.lowVoltUse;
        else if (typeof index !== 'undefined')
            logger.fatal('EnergyAndChargeMeter has no index ' + index);
                          
        let usedLastMinutes = -this.UBat * this.ILoad * timeDiff;
        return (this.meter.EWMs.lowVoltUse - subtract + usedLastMinutes) * convMsToH;
    }
    getEAbsorbed(index) {
        let timeDiff = Date.now() - this.lastTime;
        let subtract = 0;
        if (typeof index !== 'undefined' && index !== null &&
            (this.MeterStarts.has(index))) subtract = this.MeterStarts.get(index).EWMs.absorbed;
        else if (typeof index !== 'undefined')
            logger.fatal('EnergyAndChargeMeter has no index ' + index);

        let absorbedLastMinutes = 0;
        if (this.IBat > 0) absorbedLastMinutes = this.UBat * this.IBat * timeDiff;
        return (this.meter.EWMs.absorbed - subtract + absorbedLastMinutes) * convMsToH;
    }
    getEDrawn(index) {
        let timeDiff = Date.now() - this.lastTime;
        let subtract = 0;
        if (typeof index !== 'undefined' && index !== null &&
            (this.MeterStarts.has(index))) subtract = this.MeterStarts.get(index).EWMs.drawn;
        else if (typeof index !== 'undefined')
            logger.fatal('EnergyAndChargeMeter has no index ' + index);

        let drawnLastMinutes = 0;
        if (this.IBat < 0) drawnLastMinutes = -this.UBat * this.IBat * timeDiff;
        return (this.meter.EWMs.drawn - subtract + drawnLastMinutes) * convMsToH;
    }
    getEUsed(index) {
        let timeDiff = Date.now() - this.lastTime;
        let subtract = 0;
        if (typeof index !== 'undefined' && index !== null &&
            (this.MeterStarts.has(index))) subtract = this.MeterStarts.get(index).EWMs.useWhileOn;
        else if (typeof index !== 'undefined')
            logger.fatal('EnergyAndChargeMeter has no index ' + index);

        let usedLastMinutes = 0;
        if (this.RState === 'ON') {
            let IPv        = Math.max(this.IPv, 0);
            let IBat       = (this.IBat > 0 ? this.IBat : 0);
            // IPv < IBat would mean charge current is more than supplied by PV
            let EdirectUse = this.UBat * (IPv - IBat) * timeDiff;
            let Edrawn     = (this.IBat < 0 ? this.UBat * this.IBat * timeDiff : 0);
            usedLastMinutes = EdirectUse - Edrawn;
        }
        return (this.meter.EWMs.useWhileOn - subtract + usedLastMinutes) * convMsToH;
    }
    // convert Energy to Euro in IRL
    toEuroInclVAT(energyInWh) {
        //                  to kWh  to Euro  +VAT
        return energyInWh * 0.001 * 0.1604 * 1.135;
    }
    getELoss1(index) {
        let timeDiff = Date.now() - this.lastTime;
        let subtract = 0;
        if (typeof index !== 'undefined' && index !== null &&
            (this.MeterStarts.has(index))) subtract = this.MeterStarts.get(index).EWMs.loss1;
        else if (typeof index !== 'undefined')
            logger.fatal('EnergyAndChargeMeter has no index ' + index);

        let lossLastMinutes = 0;
        if (this.IBat > 0) lossLastMinutes = Math.max(0, this.UPv - this.UBat) * this.IBat * timeDiff;
        return (this.meter.EWMs.loss1 - subtract + lossLastMinutes) * convMsToH;
    }
    getELoss2(index) {
        let timeDiff = Date.now() - this.lastTime;
        let subtract = 0;
        if (typeof index !== 'undefined' && index !== null &&
            (this.MeterStarts.has(index))) subtract = this.MeterStarts.get(index).EWMs.loss2;
        else if (typeof index !== 'undefined')
            logger.fatal('EnergyAndChargeMeter has no index ' + index);

        let lossLastMinutes = this.UBat * this.IBat * timeDiff;
        return (this.meter.EWMs.loss2 - subtract + lossLastMinutes) * convMsToH;
    }
    // all getC in Ah
    getCAbsorbed(index) {
        let timeDiff = Date.now() - this.lastTime;
        let subtract = 0;
        if (typeof index !== 'undefined' && index !== null &&
            (this.MeterStarts.has(index))) subtract = this.MeterStarts.get(index).CAMs.absorbed;
        else if (typeof index !== 'undefined')
            logger.fatal('EnergyAndChargeMeter has no index ' + index);

        let absorbedLastMinutes = 0;
        if (this.IBat > 0) absorbedLastMinutes = this.IBat * timeDiff;
        return (this.meter.CAMs.absorbed - subtract + absorbedLastMinutes) * convMsToH;
    }
    getCDrawn(index) {
        let timeDiff = Date.now() - this.lastTime;
        let subtract = 0;
        if (typeof index !== 'undefined' && index !== null &&
            (this.MeterStarts.has(index))) subtract = this.MeterStarts.get(index).CAMs.drawn;
        else if (typeof index !== 'undefined')
            logger.fatal('EnergyAndChargeMeter has no index ' + index);

        let drawnLastMinutes = 0;
        if (this.IBat < 0) drawnLastMinutes =  -this.IBat * timeDiff; 
        return (this.meter.CAMs.drawn - subtract + drawnLastMinutes) * convMsToH;
    }

    writeData() {
        logger.trace('EnergyAndChargeMeter::writeData');
        // TODO: use parseFloat when reading as toFixed outputs strings
        let data = {
            time:         Date.now(),
            directUse:    this.getEDirectUse().toFixed(4),
            lowVoltUsed:  this.getELowVoltUse().toFixed(4),
            useWhileOn:   this.getEUsed().toFixed(4),
            absorbed:     this.getEAbsorbed().toFixed(4),
            drawn:        this.getEDrawn().toFixed(4),
            loss1:        this.getELoss1().toFixed(4),
            loss2:        this.getELoss2().toFixed(4),

            AhAbsorbed:   this.getCAbsorbed().toFixed(4),
            AhDrawn:      this.getCDrawn().toFixed(4),

            kWhHarvested: this.toEuroInclVAT(this.getEUsed()).toFixed(2)
        };
        let jData = JSON.stringify(data);
        logger.info('Writing meter data to file ' + file);
        let meterFile = fs.createWriteStream(file, {flags: 'w'});
        meterFile.write(jData);
    }

    readData() {
        logger.trace('EnergyAndChargeMeter::readData');

        try {
            let data = fs.readFileSync(file, 'utf8');
            let meterObj = JSON.parse(data);

            // FIXME: do a little of read resilience for other readers too!!
            let directUse  = ('directUse' in meterObj && meterObj.directUse
                              ? meterObj.directUse  : 0) / convMsToH;
            let lowVoltUse = ('lowVoltUse' in meterObj && meterObj.lowVoltUse
                              ? meterObj.lowVoltUse : 0) / convMsToH;
            let useWhileOn = ('useWhileOn' in meterObj && meterObj.useWhileOn
                              ? meterObj.useWhileOn : 0) / convMsToH;
            let absorbed   = ('absorbed' in meterObj && meterObj.absorbed
                              ? meterObj.absorbed   : 0) / convMsToH;
            let drawn      = ('drawn' in meterObj && meterObj.drawn
                              ? meterObj.drawn      : 0) / convMsToH;
            let loss1      = ('loss1' in meterObj && meterObj.loss1
                              ? meterObj.loss1      : 0) / convMsToH;
            let loss2      = ('loss2' in meterObj && meterObj.loss2
                              ? meterObj.loss2      : 0) / convMsToH;
            this.meter.EWMs.directUse  = directUse;
            this.meter.EWMs.lowVoltUse = lowVoltUse;
            this.meter.EWMs.useWhileOn = useWhileOn;
            this.meter.EWMs.absorbed   = absorbed;
            this.meter.EWMs.drawn      = drawn;
            this.meter.EWMs.loss1      = loss1;
            this.meter.EWMs.loss2      = loss2;

            absorbed = (meterObj.AhAbsorbed  ? meterObj.AhAbsorbed  : 0) / convMsToH;
            drawn    = (meterObj.AhDrawn     ? meterObj.AhDrawn     : 0) / convMsToH;
            this.meter.CAMs.absorbed  = absorbed;
            this.meter.CAMs.drawn     = drawn;
            logger.info('Meter data retrieved from ' + file);
        }
        catch (err) {
            logger.error(`cannot read: ${file} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
        }
    }

    terminate() {
        logger.debug('EnergyAndChargeMeter::terminate');
        this.writeData();
    }
}

var meter = new EnergyAndChargeMeter();
const tenMinutes = 600000; // 1000 * 60 * 10;
setInterval(meter.writeData.bind(meter), tenMinutes);

module.exports.EnergyAndChargeMeter = meter;
