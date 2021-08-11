// Battery Management System (BMS)

var VEdeviceClass = require( 've_bms_forecast' ).VictronEnergyDevice;
const interpolate = require('everpolate').linear;
var fs = require('fs');
const Math = require('mathjs');
const MPPTclient = require('tracer').MPPTDataClient;
const Alarms = require('./alarms').Alarms;
const FlowProtection = require('./protection.js').FlowProtection;
const BatteryProtection = require('./protection.js').BatteryProtection;
const ChargerOverheatProtection = require('./protection.js').ChargerOverheatProtection;
const DeviceProtection = require('./protection.js').DeviceProtection;
var log4js = require('log4js');
const ECMeter = require( './meter' ).EnergyAndChargeMeter;
const PVInputFromIrradianceML = require( './forecast' ).PVInputFromIrradianceML;
var forecast = require( './forecast' );
const UsageBuckets = require('./usage-statistic').HourlyUsageBuckets;


let mppt = new MPPTclient(0); // poking in intervals done below
const logger = log4js.getLogger();

// extend standard Array by unique function
Array.prototype.unique = function() {
    let a = this.concat();
    for(let i=0; i<a.length; ++i) {
        for(let j=i+1; j<a.length; ++j) {
            if(a[i] === a[j])
                a.splice(j--, 1);
        }
    }
    return a;
};

function isNumber(value)
{
    return typeof value === 'number'; // && isFinite(value);
}

function isInRange(value, min, max) {
    if (value < min) return false;
    if (value > max) return false;
    return true;
}

function getInRange(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

function getPercentualSOC(soc) {
    return getInRange(soc, 0.0, 100.0);
}





// currents and voltages in SI units
class Flow {

    // minCurrent, maxCurrent and currents in/output to/from setCurrent and getCurrent
    // must have the same "base" i.e. be SI or all in mA, microA etc.
    // minVoltage, maxVoltage and voltages in/output to/from setVoltage and getVoltage
    // must have the same "base"
    constructor() {
        this.actualVoltage = 0;
        this.actualCurrent = 0;
    }

    // \param current in a scale such that current * scaleCurrent results in ampers
    //        rather than milli ampers or so
    setCurrent(current) {
        let I = (typeof current === 'string' ? parseFloat(current) : current);
        if (! isNaN(I)) {
            //logger.debug('setCurrent: ' + I);
            this.actualCurrent = I;
        }
    }

    getCurrent() {
        logger.trace('getCurrent: ' + this.actualCurrent);
        return this.actualCurrent;
    }

    // \param voltage in a scale such that voltage * scaleVoltage results in volts
    //        rather than milli volts or so
    setVoltage(voltage) {
        let U = (typeof voltage === 'string' ? parseFloat(voltage) : voltage);
        //console.log("U = " + U);
        if (! isNaN(U)) {
            //logger.debug('setVoltage: ' + U);
            this.actualVoltage = U;
        }
    }

    getVoltage() {
        logger.trace('getVoltage: ' + this.actualVoltage);
        return this.actualVoltage;
    }

    getResistance() {
        if (this.actualCurrent === 0) return 0;
        return this.actualVoltage / this.actualCurrent;
    }

    getPower() {
        return this.actualVoltage * this.actualCurrent;
    }
}

class RestingCharacteristic
{
    // Gel Battery:
    // 12.0V 12.00 11.76 11.98  0%
    // 12.2V 12.25 12.00        25%
    // 12.3V 12.40 12.30 12.40  50%
    // 12.5V 12.60 12.55        75%
    // 12.8V 12.80 12.78 12.80 100%
    //               ^ am zuverlaessigsten
    constructor(characteristic) {
        // taken the average of the above voltages
        this.voltage = characteristic.voltage;
        this.soc     = characteristic.soc;
        this.maxRestingCurrent = characteristic.maxRestingCurrent; // 50mA
    }

    isApplicable(flow) {
        // use small threshold as 0 will rarely happen
        return flow.getCurrent() <= Math.abs(this.maxRestingCurrent);
    }

    getSOC(flow) {
        let soc = interpolate(flow.getVoltage(), this.voltage, this.soc);
        return getPercentualSOC(soc);
    }
}


class IntegralOverTime
{
    constructor(value, timeStamp) {
        this.integral = 0;
        this.lowerIntegral = 0;
        this.upperIntegral = 0;
        this.lastValue    = value;
        if (timeStamp !== undefined && timeStamp !== null)
            this.lastTime = timeStamp;
        else
            this.lastTime = Date.now();
        this.firstTime    = this.lastTime;
        this.isAscending  = false;
        this.isDescending = false;
        this.offset       = 0;
    }

    setOffset(offset) {
        this.offset = offset;
    }

    add(value, timeStamp)
    {
        let currentTime = 0;
        const duration = timeStamp - this.lastTime; // milliseconds
        this.lastTime = timeStamp;
        //console.log("measured duration: " + duration);
        let lower = 0;
        let upper = 0;
        if (this.lastValue > value)
        {
            lower = duration * value;
            upper = duration * this.lastValue;
            this.isAscending = false;
        }
        else
        {
            lower = duration * this.lastValue;
            upper = duration * value;
            this.isAscending = true;
        }
        if (this.lastValue !== value)
        {
            this.isDescending = ! this.isAscending;
        }
        else
        {
            this.isAscending = this.isDescending = false;
        }
        this.lowerIntegral += lower;
        this.upperIntegral += upper;
        this.integral += 0.5 * (lower + upper);
        this.lastValue = value;
    }

    getIntegral()
    {
        return this.offset + this.integral;
    }

    isAscendingTrend()
    {
        return this.isAscending;
    }

    isDescendingTrend()
    {
        return this.isDescending;
    }

    getDuration()
    {
        return this.lastTime - this.firstTime;
    }

    getLastTimeStamp()
    {
        return this.lastTime;
    }

    getAvgValue()
    {
        return this.integral / this.getDuration();
    }

    getLowerIntegral()
    {
        return this.offset + this.lowerIntegral;
    }

    getUpperIntegral()
    {
        return this.offset + this.upperIntegral;
    }
}


class Charge extends IntegralOverTime {
    // FIXME: rethink: do we need to hand over value/timestamp here, if so get it right
    constructor(value, timeStamp) {
        super(value, timeStamp);
    }

    addCurrent(current, timeStamp) {
        let currentTime = 0;
        if (timeStamp !== undefined && timeStamp !== null)
            currentTime = timeStamp;
        else
            currentTime = Date.now(); // time in milliseconds since epoch
        this.add(current, currentTime * 0.001);
    }
}



// \brief Charge characteristic when floating for a
//        n cell battery with capacity c
//        n cells in series, c is the total capacity
//        c is e.g. 200Ah for a 200Ah nominal capacity battery
//        If two 200Ah batteries are in series, c is 400Ah
// Bleiakku: ladeschlussspannung = 2.42V/Zelle -> 14.52
class FloatChargeCharacteristic {

    // \details The float charge characteristic is given by the file
    //          charge_characteristic.json json object floatcharge.
    //          The voltages are typically specified by cells.
    //          The currents are typically specified based on the
    //          nominal capacity. What does that mean (example)?
    //          Lead acid based batteries (better accumulators)
    //          as used for cars, solar systems etc. often have
    //          12 V which means 6 cells of 2 Volts.
    //          Hence, if your floatcharge characteristic is
    //          given in the 2 V range you must set cells to 6.
    //
    //          The currents of the floatcharge are typically
    //          based on the capacity. That means the given currents
    //          must be multiplied with the capacity to get the real
    //          current for that accumulator. If the current is
    //          is measured across the 6 cells of the accumulator
    //          you must specifiy the capacity of the 6 cells.
    //          If two accumulators are in parallel, i.e. 12 cells
    //          and the current is measured for all 12 cells you
    //          must give the capacity of the 12 cells.
    //
    //          Contrary to the understanding currents where the
    //          current splits across parallel but will be the
    //          same going through serial consumers, it is
    //          different for the charging process. Parallel
    //          accumulators with same characteristics will
    //          take equal parts of the current (sharing as
    //          known from electrical consumers). However,
    //          a charging current will split across all
    //          cells that are in series. So the current is
    //          actually split over the cells as if they
    //          were in parallel.
    //
    //          To make this specification more clear look
    //          at the example of having 4 x 12 V accus
    //          two of them in series and the 2 series parallel
    //          to each other:
    //               |- 12V +|- 12V +|
    //          - __/        |        \__ + I
    //              \        |        /
    //               |- 12V +|- 12V +|
    //                  UL      UT
    //          You measure the float charge of the two lower accus
    //          UL and the two upper accus while the measured
    //          current I splits over all accus. The float charge
    //          characteristic is given per cell: each accu has
    //          6 cells (of approx. 2V). To keep it simple we assume
    //          each accu has a capacity of 200Ah.
    //          As you are measuring UL across 6 cells each (yes,
    //          actually 12 cells but 6 x (2 cell packs in parallel)
    //          you must specify 6 for the number of cells.
    //          As your current is measured for the total system,
    //          you must specify the capacity of the total system
    //          which is 800Ah.
    //
    // \param fc a specification of the float charge characteristic
    //        containing 3 objects: current, voltage, SOC each of
    //        which contains an array of timestamps in hours
    //        and associated measurements of currents, voltages and
    //        SOCs.
    // \param cells is n (number of cells daisy chained in series)
    // \param capacity is the total capacity of all cells in parallel
    constructor(fc, cells, capacity) {
        logger.trace("FloatChargeCharacteristic::constructor");
        this.isOperational = false;
        this.resistance = new Array();
        this.soc = new Array(); // state of charge
        // each accumulated ampere hour while charging must be multiplied by the appropriate
        // factor this.reduceAh[i]:
        this.reduceAh = new Array(); // reduction factors for incoming ampere hours to real charge
        this.simplefAh = new Array(); // reduction factors for incoming ampere hours to real charge

        // concat the time data, sort and make entries unique
        let tmp      = fc.current.hours.concat(fc.voltage.hours).unique();
        this.timeTags = tmp.concat(fc.SOC.hours).unique();
        this.timeTags.sort(function(a, b){return a - b});

        this.I  = interpolate(this.timeTags, fc.current.hours, fc.current.I);
        this.U  = interpolate(this.timeTags, fc.voltage.hours, fc.voltage.U);
        // capacity in percent
        this.CP = interpolate(this.timeTags, fc.SOC.hours,     fc.SOC.percent);
        let cellCapacityScale = cells / capacity;
        this.R = this.U.map(function (u, idx) {
            return cellCapacityScale * u / this.I[idx];
        }.bind(this));

        this.simpleCalcReduceAh(cells, capacity);
        this.convResistanceToSOC(cells, capacity);
        this.calcResistanceToReduceAh(cells, capacity);

        console.log("i, I(i), U(i), CP(i)");
        this.I.map(function(i, idx) {
            console.log(idx + ", " + i + ", " + this.U[idx] + ", " + this.CP[idx]);
        }.bind(this));
        console.log("i, R(i), SOC(i), fAh(i)");
        // FIXME: entry 19, 20, 21 of SOC(i) and fAh(i) contains undefined:
        this.R.map(function(r, idx) {
            console.log(idx + ", " + r + ", " + this.soc[idx] + ", " + this.reduceAh[idx]);
        }.bind(this));
        console.log("i, simplefAh(i)");
        this.simplefAh.map(function(f, idx) {
            console.log(idx + ", " + f);
        });

        // FIXME: do we still need isOperational since getSOC calls can come in earlier
        // it may take a while till charge_characteristic.json is read
        if (this.resistance.length === 0 || this.soc.length === 0 || this.reduceAh.length === 0)
            throw "Float charge characteristic is empty";
        else this.isOperational = true;
    }

    simpleCalcReduceAh(cells, capacity)
    {
        let subtract = 0;
        for (let i = 0; i < this.CP.length-1 ; i++) {
            this.CP[i] = this.CP[i] - subtract;
            let f = (this.CP[i+1] - this.CP[i]) /
                (50 * (this.I[i] + this.I[i+1]) * (this.timeTags[i+1] - this.timeTags[i]));
            if (f <= 1)
                this.simplefAh.push(f);
            else {
                let newCP = this.CP[i] +
                    (50 * (this.I[i] + this.I[i+1]) * (this.timeTags[i+1] - this.timeTags[i]))
                subtract = this.CP[i+1] - newCP;
            }
        }
    }

    // \brief create function R -> SOC(R)
    convResistanceToSOC(cells, capacity) {
        if (this.R.length > 0 && this.CP.length > 0) {
            this.resistance.push(this.R[0]);
            this.soc.push(this.CP[0]);

            for(let i = 1; i < this.R.length; ++i) {
                if(this.R[i-1] !== this.R[i])
                {
                    this.resistance.push(this.R[i]);
                    this.soc.push(this.CP[i]);
                }
                //else console.log("there are equal resistances");
            }
        }
    }

    // \detail When charging not all current goes into
    //         the battery, so accumulating current times
    //         time (Ah) will show more charge volume than
    //         reality. Reading the charge characteristic
    //         during a small duration deltaT=t_1-t_0 the
    //         current deltaI flow into the battery.
    //         Ideally this would add a volume of
    //         deltaI * deltaT.
    //         However, the charge characteristic states
    //         that the SOC(t_1)-SOC(t_0) * nominalCapacity
    //         = deltaSOC * nominalCapacity is less.
    //         Calculating the function
    //         (with C_n = nominalCapacity):
    //         C_n * deltaSOC/(deltaI * deltaT)
    //         is a factor function that needs to be
    //         multiplied to the accumulated volume.
    //         Using the injective function t -> R
    //         a function
    //         f(R):= C_n * deltaSOC(R)/(deltaI * deltaT)
    //         can be constructed.
    calcResistanceToReduceAh(cells, capacity) {

        // looking at i = 0:
        {
            // change of CP around index i:
            // 0.5*(this.CP[1] + this.CP[0]) - this.CP[0]
            let gradCP = 0.5 * (this.CP[1] - this.CP[0]);
            // gradCP must be multiplied by 0.01 to go from percentage to float
            // and by capacity to reach to ampere hours
            //
            // ampere hours around index i:
            // 0.5 * (this.I[0] + 0.5 * (this.I[1]+this.I[0])) * (0.5*(timeTags[1]+timeTags[0])-timeTags[0])
            let ampHrs = 0.25 * (1.5*this.I[0] + 0.5*this.I[1]) * (this.timeTags[1] - this.timeTags[0]);
            // ampHrs must be multiplied with the capacity as this.I and fc.current.I
            // as the characteristic specifies the values per 2V cell.
            // factor of increase of SOC compared to ingoing ampere hours:
            // capacity * gradCP * 0.01 / (capacity * ampHrs)
            let factor =  gradCP * 0.01 / ampHrs;
            // resistance at index i: this.R[i]
            this.reduceAh.push(factor);
        }
        for (let i = 1; i < this.timeTags.length-1; ++i)
        {
            // looking at interval [i - 1/2; i + 1/2]:
            // change of CP around index i:
            // (0.5*(this.CP[i+1] + this.CP[i]) - 0.5*(this.CP[i] + this.CP[i-1]));
            let gradCP = 0.5 * (this.CP[i+1] - this.CP[i-1]);
            // gradCP must be multiplied by 0.01 to go from percentage to float
            // and by capacity to reach to ampere hours
            //
            // ampere hours around index i:
            // 0.5 * (0.5 * (this.I[i]+this.I[i-1]) + this.I[i]) * (timeTags[i] - 0.5*(timeTags[i]+timeTags[i-1]))
            // + 0.5 * (this.I[i] + 0.5 * (this.I[i+1]+this.I[i])) * (0.5*(timeTags[i+1]+timeTags[i])-timeTags[i])
            let ampHrs = 0.5 * ((0.75*this.I[i]+0.25*this.I[i-1]) * (this.timeTags[i]-this.timeTags[i-1])
                                + (0.75*this.I[i] + 0.25*this.I[i+1]) * (this.timeTags[i+1]-this.timeTags[i]));
            // ampHrs must be multiplied with the capacity as this.I and fc.current.I
            // as the characteristic specifies the values per 2V cell.
            // factor of increase of SOC compared to ingoing ampere hours:
            // capacity * gradCP * 0.01 / (capacity * ampHrs)
            let factor =  gradCP * 0.01 / ampHrs;
            // resistance at index i: this.R[i]
            if (this.R[i-1] !== this.R[i])
                this.reduceAh.push(factor);
            else
            {
                let a = this.reduceAh[this.reduceAh.length-1];
                a = (a+factor) * 0.5;
                this.reduceAh[this.reduceAh.length-1] = a;
            }
        }

        // looking at n = timeTags.length-1:
        {
            let n = this.timeTags.length-1;
            let gradCP = 0.5 * (this.CP[n] - this.CP[n-1]);
            // gradCP must be multiplied by 0.01 to go from percentage to float
            // and by capacity to reach to ampere hours
            //
            // ampere hours around index n:
            // 0.5 * (0.5 * (this.I[n]+this.I[n-1]) + this.I[n]) * (timeTags[n] - 0.5*(timeTags[n]+timeTags[n-1]))
            let ampHrs = 0.25 * (1.5*this.I[n]+0.5*this.I[n-1]) * (this.timeTags[n]-this.timeTags[n-1]);
            // ampHrs must be multiplied with the capacity as this.I and fc.current.I
            // as the characteristic specifies the values per 2V cell.
            // factor of increase of SOC compared to ingoing ampere hours:
            // capacity * gradCP * 0.01 / (capacity * ampHrs)
            let factor =  gradCP * 0.01 / ampHrs;
            // resistance at index i: this.R[i]
            if (this.R[n-1] !== this.R[n])
                this.reduceAh.push(factor);
            else
            {
                // let a = this.reduceAh[this.reduceAh.length-1];
                // // FIXME make factor <= 1
                // a = (a+factor) * 0.5;
                // this.reduceAh[this.reduceAh.length-1] = a;
            }
        }
    }

    isApplicable(flow) {
        return this.isOperational && flow.getCurrent() > 0;
    }

    getSOC(flow) {
        let current = flow.getCurrent();
        let voltage = flow.getVoltage();
        //console.log("actual current = " + current);
        //console.log("actual voltage = " + voltage);
        if (! this.isApplicable(flow))
            return 0;
        let atValue = flow.getResistance();
        let soc = 0;
        soc = interpolate(atValue, this.resistance, this.soc);
        soc = getPercentualSOC(soc);
        //console.log("SOC = " + soc);
        return soc;
    }
}


class FloatVolume {
    // \param accumulator is a shared accumulator where any FloatVolume
    //        class managing it may change the max charge volume
    // \param chargeCharacteristic is either FloatChargeCharacteristic
    //        DischargeCharacteristic or RestingCharacteristic
    constructor(accumulator,
                chargeCharacteristic,
                dischargeCharacteristic,
                restingCharacteristic) {
        this.accumulator   = accumulator;
        this.chargeChar    = chargeCharacteristic;
        this.dischargeChar = dischargeCharacteristic;
        this.restingChar   = restingCharacteristic;
        this.characteristic = null;
        let flow = new Flow();
        this.integrator  = new IntegralOverTime(flow, Date.now());

        // Algorithm:
        // depending on the current (<0, >0, =0)
        // 1. calculate estimated SOC and diff to the running integrator
        // 2. Maybe near 0A: eventually 3 estimations are running
        // 3. charge to discharge or discharge to charge must traverse
        //    through =0 state
        //    When =0 state is traversed from
        //    charge to =0 to discharge then akku capacity is corrected
        //    and the longer the current stays near =0 the more the
        //    integrator interval shrinks.
        //    When =0 is traversed from
        //    discharge to charge, same is done.

        this.lastEstimatedVolume = this.accumulator.getNominalCapacity() * 0.5;
        this.lastLowerIntegral = this.integrator.getLowerIntegral();
        this.lastUpperIntegral = this.integrator.getUpperIntegral();
        this.lowerVolume = this.lastEstimatedVolume;
        this.upperVolume = this.lastEstimatedVolume;
    }

    setCharacteristic(flow) {
        // TODO: several characteristic may be applicable e.g. for small currents
        if (this.chargeChar.isApplicable(flow)) {
            this.characteristic = this.chargeChar;
        } else if (this.dischargeChar.isApplicable(flow)) {
            this.characteristic = this.disChargeChar;
        }
    }

    initIntegrator(flow, timeInSec) {
        // initialize integrator with first flow:
        this.integrator  = new Charge(flow, timeInSec);
        this.setCharacteristic(flow);
        let volume = this.accumulator.getCapacityInAh(this.characteristic.getSOC(flow));
        let rvolume = this.accumulator.getCapacityInAh(this.restingChar.getSOC(flow));
        if (this.restingChar.isApplicable(flow))
        {
            // scale this.characteristic.SOC to restingChar
        }
        else
        {
            // depending on flow.getCurrent() > or < 0 limit this.characteristic.SOC by this.restingChar.SOC
        }
        this.integrator.setOffset(volume);
    }

    // \param flow is of class Flow
    addFlow(flow, timeInSec) {
        // Initialization
        if (this.integrator === null) {
            this.initIntegrator(flow, timeInSec);
            return;
        }
        // Voltage/current based volume estimation:
        this.setCharacteristic(flow);
        let estimatedVolume = this.accumulator.getCapacityInAh(this.characteristic.getSOC(flow));

        // Integral volume:
        this.integrator.addCurrent(flow.getCurrent(), timeInSec);

        // Synchronisation of two volume estimation methods:
        // FIXME: what is the final volume now?
        if (estimatedVolume > this.integrator.getUpperIntegral()) {
            // reduce capacity by 5%
            this.accumulator.setCapacity(this.accumulator.getCapacity() * 0.95);
            //console.log("Correction - accu capacity reduced by 5%");
        } else if (estimatedVolume < this.integrator.getLowerIntegral()) {
            this.integrator.setOffset(estimatedVolume - this.integrator.getLowerIntegral());
            //console.log("Correction - integration offset reduced by " + estimatedVolume - this.integrator.getLowerIntegral());
        }
        this.volume = (estimatedVolume + this.integrator.getIntegral()) * 0.5;
    }
}


// \brief Charge characteristic when discharging for a
//        n cell battery with capacity c
//        n cells in series, c is the total capacity
//        c is e.g. 200Ah for a 200Ah nominal capacity battery
//        If two 200Ah batteries are in series, c is 400Ah
class DischargeCharacteristic {

    // \param cells is n (number of cells daisy chained in series)
    // \param capacity is the total capacity of all cells in parallel
    constructor(cells, capacity) {
    }

    isApplicable(flow) {
        return flow.getCurrent() < 0;
    }

    getSOC(flow) {
        if (! isApplicable(flow)) return 0;
        let soc = 0;
        return getPercentualSOC(soc);
    }


}


    // // FIXME: move capacity by temp correction in other class
    // this.capacityByTemp = null;
    // this.actualCTFactor = 1;
    // this.capacityByTemp = cc.capacityByTemp;
    // setCapacityByTemperature(actualTempInC);

    // setCapacityByTemperature(actualTempInC) {
    //  this.actualCTFactor = interpolate(actualTempInC,
    //                       this.capacityByTemp.celcius
    //                       this.capacityByTemp.percent);
    // }


// nach einer Tiefentladung unbedingt voll laden!!!

// Betriebseigenschaften
// Entladetiefe (DOD) max. 80% (Ue= 1,91 V/Zelle für Entladezeiten >10 h; 1,74 V/Zelle für 1 h)
// Tiefentladungen auf mehr als 80 % DOD sind zu vermeiden.
// Ladestrom ist unbegrenzt, der Mindestladestrom sollte I10 betragen.
// Ladespannung Zyklenbetriebauf 2,30 V bis 2,40 V pro Zelle beschränkt, Gebrauchsanweisung beachten
// Ladeerhaltungsspannung/ nicht zyklischer Betrieb 2,25 V/Zelle
// keine Anpassung der Ladespannung notwendig, sofern die Batterietemperatur im Monatsdurchschnitt zwischen 10 °C und 45 °C beträgt, ansonsten U/T = -0.003 V/Zelle pro K
// Vollladung auf 100 % innerhalb des Zeitraums zwischen 1 bis 4 Wochen
// IEC 61427 Zyklen >3000 Zyklen
// Batterietemperatur -20 °C bis 45 °C, empfohlener Temperaturbereich 10 °C bis 30°C Selbstentladungca. 2 % pro Monat bei 20 °C


// \detail Extension for VEdeviceClass making available
//         the lower and upper voltages for accumulators
//         in series: i.e. add object 'topVoltage'
class VEdeviceSerialAccu extends VEdeviceClass {

    constructor(cmd) {
        super();

        // Demonstration how to create additional objects
        // and how to make them fire on update events:
        // map an additional component topVoltage
        // FIXME: which works reliably this.cache or bmvdata (which is not exported)
        this.cache = this.update();
        // FIXME: replace all bmvdata's by this.cache
        let bmvdata = this.update();
        this.cache['topVoltage'] = this.createObject(0.001,  "V", "Top Voltage",
                                                     { 'precision': -1 });
        // Make midVoltage and upperVoltage fire topVoltage's callback "on"
        // if there is a change in these dependencies
        // bmvdata.upperVoltage.on.push(
        //     ((newValue, oldValue, packageArrivalTime, key) => {
        //         if (bmvdata.topVoltage.newValue !== null) return; // already updated by midVoltage
        //         let midVoltage = bmvdata.midVoltage.newValue;
        //         // if runOnFunction was called for midVoltage then newValue is null
        //         if (midVoltage === null) midVoltage = bmvdata.midVoltage.value;
        //         bmvdata.topVoltage.newValue = newValue - midVoltage;
        //         // TODO: add returned object to changeObjects
        //         this.rxtx.runOnFunction('topVoltage', bmvdata.topVoltage);
        //     }).bind(this)
        // );
        // bmvdata.midVoltage.on.push(
        //     ((newValue, oldValue, packageArrivalTime, key) => {
        //         if (bmvdata.topVoltage.newValue !== null) return; // already updated by upperVoltage
        //         let upperVoltage = bmvdata.upperVoltage.newValue;
        //         // if runOnFunction was called for upperVoltage then newValue is null
        //         if (upperVoltage === null) upperVoltage = bmvdata.upperVoltage.value;
        //         bmvdata.topVoltage.newValue = upperVoltage - newValue;
        //         // TODO: add returned object to changeObjects
        //         this.rxtx.runOnFunction('topVoltage', bmvdata.topVoltage);
        //     }).bind(this)
        // );
        // FIXME: topVoltage still not correctly updated - possibly needs the "dirty"
        //        cache handling
        // create upperVoltage in Cache - this would be created dynamically
        // but its existence is required to push the 'on' function
        this.registerComponent('V'); // upperVoltage
        this.cache.upperVoltage.on.push(
            ((newValue, oldValue, packageArrivalTime, key) => {
                if (this.cache.topVoltage.newValue !== null) return; // topValue already set
                let midVoltage = this.cache.midVoltage.newValue;
                // it always arrives a set of parameters together, so either
                // upperVoltage's and midVoltage's newValue is != null for both or
                // for none
                if (midVoltage === null) return;
                newValue = newValue / this.cache.upperVoltage.nativeToUnitFactor;
                this.cache.topVoltage.newValue = newValue - midVoltage;
                this.cache.isDirty = true;
                // TODO: add returned object to changeObjects
                // FIXME: set dirty flag and run updateValuesAnd...() if dirty
                //this.rxtx.runOnFunction('topVoltage', this.cache.topVoltage);
            }).bind(this)
        );
        // create midVoltage in Cache - this would be created dynamically
        // but its existence is required to push the 'on' function
        this.registerComponent('VM'); // midVoltage
        this.cache.midVoltage.on.push(
            ((newValue, oldValue, packageArrivalTime, key) => {
                if (this.cache.topVoltage.newValue !== null) return; // topValue already set
                let upperVoltage = this.cache.upperVoltage.newValue;
                // it always arrives a set of parameters together, so either
                // upperVoltage's and midVoltage's newValue is != null for both or
                // for none
                if (upperVoltage === null) return;
                newValue = newValue / this.cache.midVoltage.nativeToUnitFactor;
                this.cache.topVoltage.newValue = upperVoltage - newValue;
                this.cache.isDirty = true;
                // TODO: add returned object to changeObjects
                //this.rxtx.runOnFunction('topVoltage', this.cache.topVoltage);
            }).bind(this)
        );
        // this.cache.topSOC          = createObject(1,  "%", "Top SOC", {'formatter' : function()
        // {
        //      let topSOC    = estimate_SOC(this.cache.topVoltage.formatted());
        //      topSOC = Math.round(topSOC * 100) / 100;
        //      return topSOC;
        // }});
        // this.cache.bottomSOC      = createObject(1,  "%", "Bottom SOC", {'formatter' : function()
        // {
        //      let bottomSOC = estimate_SOC(this.cache.midVoltage.formatted());
        //      bottomSOC = Math.round(bottomSOC * 100) / 100;
        //      return bottomSOC;
        // }});
    }
}

class Accumulator {
    constructor(amperHours) {
        this.maxCapacityInAh = amperHours;
        this.capacityInAh    = amperHours; // capacity declines with time
    }

    setCapacity(c) {
        // TODO: later possibly allow decreasing capacityInAh only
        //if (c < this.capacityInAh) this.capacityInAh = c;
        //console.log("Change Accu Capacity to " + c);
        this.capacityInAh = c;
    }

    getSOC(amperHours) {
        return getPercentualSOC(100.0 * amperHours / this.capacityInAh); // * 100 => convert to percentage
    }

    getNominalCapacity() {
        return this.maxCapacityInAh;
    }

    getCapacity() {
        return this.capacityInAh;
    }

    // \param soc in percent i.e. in [0; 100]
    getCapacityInAh(soc) {
        return this.capacityInAh * soc * 0.01;
    }
}

const scaleSecondsToHours = 1 / (60 * 60);

// \class Battery Management System
class BMS extends VEdeviceSerialAccu {
    constructor() {
        logger.trace("BMS::constructor");
        super();

        this.appConfig = null;

        this.lowerFloatC   = null;
        this.upperFloatC   = null;

        this.alarms                      = null;
        this.bottomBattProtectionLP      = null;
        this.bottomBattProtectionHP      = null;
        this.topBattProtectionLP         = null;
        this.topBattProtectionHP         = null;
        this.chargerProtectionLP         = null;
        this.chargerProtectionHP         = null;
        this.chargerLoadProtectionLP     = null;
        this.chargerLoadProtectionHP     = null;
        this.chargerOverheatProtectionHP = null;
        this.deviceProtection            = new DeviceProtection(this);
        this.usageBuckets                = null;

        this.tracerInterval = 2000;
        this.isMaster = 1;

        const filename = __dirname + '/app.json';
        this.readConfig(filename);

        let bmvdata = this.update();

        // device limitations of inverter and charger
        // TODO: read min/max from file

        this.topFlow     = new Flow();
        this.bottomFlow  = new Flow();
        this.chargerFlow = new Flow();
        this.loadFlow    = new Flow();
        this.pvFlow      = new Flow();

        // accu characteristics
        // TODO: read 200Ah from file
        // FIXME: name bottom + top for accus for flows, float volumes etc - better construct for top and bottom separately
        //        and have two instances...
        this.bottomAccumulator = new Accumulator(2 * 200); // 2 accus in parallel like one 400Ah accu
        this.topAccumulator = new Accumulator(2 * 200); // 2 accus in parallel like one 400Ah accu

        // // FIXME: the following voltage should be the same as bmvdata.upperVoltage
        // //        possible solution: average these voltages
        // this.registerListener('MPPTbatteryVoltage', this.setAccuChainVoltage.bind(this));

        this.topFloatVolume = new FloatVolume(this.topAccumulator, this.upperFloatC, this.upperDischargeC, this.upperRestingC);
        this.bottomFloatVolume = new FloatVolume(this.bottomAccumulator, this.lowerFloatC, this.lowerDischargeC, this.lowerRestingC);

        //this.lowerIncCapacity = new IntegralOverTime(this.bottomFlow.getCurrent());
        //this.upperIncCapacity = new IntegralOverTime(this.topFlow.getCurrent());

        this.registerListener('ChangeList', this.processData.bind(this));

        this.hideBMVdisplayParams();
        this.createMPPTobjects();
        this.startPolling();
    }

    startPolling() {
        this.interval = setInterval(function () {
            if (module.exports.BMSInstance.isMaster) mppt.requestData();
            let data = mppt.getData();

            if (! data || ! data.batteryVoltage ) return; // no data yet
            
            let bmvdata = module.exports.BMSInstance.update();
            bmvdata.MPPTbatteryVoltage.newValue     = data.batteryVoltage;
            bmvdata.MPPTpvVoltage.newValue          = data.PvVoltage;
            bmvdata.MPPTloadCurrent.newValue        = data.loadCurrent;
            bmvdata.MPPTisOverload.newValue         = data.isOverload;
            bmvdata.MPPTisShortcutLoad.newValue     = data.isLoadShortCircuit;
            bmvdata.MPPTisBatteryOverload.newValue  = data.isBatteryOverload;
            bmvdata.MPPTisOverDischarge.newValue    = data.isOverDischarge;
            bmvdata.MPPTisFullIndicator.newValue    = data.isFullIndicator;
            bmvdata.MPPTisCharging.newValue         = data.chargingIndicator;
            bmvdata.MPPTbatteryTemperature.newValue = data.batteryTemperature;
            bmvdata.MPPTchargingCurrent.newValue    = data.chargingCurrent;
        }.bind(mppt), this.tracerInterval);
    }

    stopPolling() {
        logger.debug("BMS::stopPolling");
        clearInterval(this.interval);
        if (this.pvInput) this.pvInput.terminate();
        this.alarms.terminate();

        ECMeter.terminate(); // write out meter data

        if (this.usageBuckets) this.usageBuckets.terminate();
    }

    hideBMVdisplayParams() {
        // hide 'useless' parameters in BMV display
        this.setShowTimeToGo(0);
        this.setShowTemperature(0);
        this.setShowPower(0);
        this.setShowConsumedAh(0);
    }
    
    readConfig(filename) {
        logger.trace("BMS::readConfig");
        if (this.appConfig !== null) return; // appConfig read before
        // read config file
        try {
            let data = fs.readFileSync(filename, 'utf8');

            logger.debug(`BMS::readConfig - Parse ${filename} configuration (JSON format)`);
            this.appConfig = JSON.parse(data);
            if (! this.appConfig)
                throw 'BMS::readConfig - no configuration found';
        }
        catch (err) {
            logger.error(`Cannot read: ${filename} (${err.code === 'ENOENT' ? 'does not exist' : 'is not readable'})`);
        }

        this.readChargingConfig();
        this.alarms = new Alarms();
        this.alarms.parseConfig(this.appConfig);
        this.usageBuckets = new UsageBuckets();
        this.usageBuckets.parseConfig(this.appConfig);
        this.readProtectionConfig();
        this.readTracerConfig();
        this.readOpenWeatherConfig();
    }

    readChargingConfig() {
        let c = null;
        if ('Charging' in this.appConfig) {
            logger.info("BMS::readChargingConfig - reading Charging");
            c = this.appConfig['Charging'];
        } else throw 'BMS::readChargingConfig - no charge characteristics defined';

        let fc = null;
        if ('floatcharge' in c) {
            logger.info("BMS::readChargingConfig - reading floatcharge");
            fc = c['floatcharge'];
        } else throw 'BMS::readChargingConfig - no floatcharge characteristics defined';

        // The measured Voltage in this process nominal 12 V for the upper and nominal 12 V
        // for the lower pack. The measured current splits across all accumulators, the
        // 2 lower and 2 upper, i.e. across 800 Ah.
        this.lowerFloatC   = new FloatChargeCharacteristic(fc, 6, 400); //this.accumulator.getNominalCapacity());
        this.upperFloatC   = new FloatChargeCharacteristic(fc, 6, 400); //this.accumulator.getNominalCapacity());
        
        let rc = null;
        if ('restingCharge' in c) {
            logger.info("BMS::readChargingConfig - reading restingCharge");
            rc = c['restingCharge'];
        } else throw 'BMS::readChargingConfig - no restingCharge characteristics defined';

        this.lowerRestingC = new RestingCharacteristic(rc);
        this.upperRestingC = new RestingCharacteristic(rc);
        // FIXME: temporary use RestingChara. until DischargeChar is defined
        this.lowerDischargeC = new RestingCharacteristic(rc);  
        this.upperDischargeC = new RestingCharacteristic(rc);
    }

    readProtectionConfig() {
        let p = null;
        if ('Protection' in this.appConfig) {
            logger.info("BMS::readProtectionConfig - reading Protection");
            p = this.appConfig['Protection'];
        } else throw 'BMS::readProtectionConfig - no Protection section defined';
        
        if ('BatteryProtection' in p)
            this.batteryProtection = new BatteryProtection(p.BatteryProtection, this);
        else throw 'BMS::readProtectionConfig - no BatteryProtection section defined';

        if ('BatteryProtectionLowPriority' in p) {
            this.bottomBattProtectionLP = new FlowProtection(0, 'Bottom battery' , p.BatteryProtectionLowPriority, this);
            this.topBattProtectionLP    = new FlowProtection(2, 'Top battery' , p.BatteryProtectionLowPriority, this);
        }
        else throw 'BMS::readProtectionConfig - no BatteryProtectionLowPriority section defined';
        
        if ('BatteryProtectionHighPriority' in p) {
            this.bottomBattProtectionHP = new FlowProtection(1, 'Bottom battery' , p.BatteryProtectionHighPriority, this);
            this.topBattProtectionHP    = new FlowProtection(3, 'Top battery' , p.BatteryProtectionHighPriority, this);
        }
        else throw 'BMS::readProtectionConfig - no BatteryProtectionHighPriority section defined';

        if ('ChargerProtectionLowPriority' in p)
            this.chargerProtectionLP = new FlowProtection(4, 'Charger' , p.ChargerProtectionLowPriority, this);
        else throw 'BMS::readProtectionConfig - no ChargerProtectionLowPriority section defined';

        if ('ChargerProtectionHighPriority' in p)
            this.chargerProtectionHP = new FlowProtection(5, 'Charger' , p.ChargerProtectionHighPriority, this);
        else throw 'BMS::readProtectionConfig - no ChargerProtectionHighPriority section defined';

        if ('ChargerLoadProtectionLowPriority' in p)
            this.chargerLoadProtectionLP = new FlowProtection(6, 'Charger load' , p.ChargerLoadProtectionLowPriority, this);
        else throw 'BMS::readProtectionConfig - no ChargerLoadProtectionLowPriority section defined';

        if ('ChargerLoadProtectionHighPriority' in p)
            this.chargerLoadProtectionHP = new FlowProtection(7, 'Charger load' , p.ChargerLoadProtectionHighPriority, this);
        else throw 'BMS::readProtectionConfig - no ChargerLoadProtectionHighPriority section defined';

        if ('ChargerOverheatProtectionHighPriority' in p)
            this.chargerOverheatProtectionHP = new ChargerOverheatProtection(8, 'Charger Overheat' , p.ChargerOverheatProtectionHighPriority, this);
        else throw 'BMS::readProtectionConfig - no ChargerOverheatProtectionHighPriority section defined';
    }

    readTracerConfig() {
        let t = null;
        if ('Tracer' in this.appConfig) {
            logger.info("BMS::readTracerConfig - reading Tracer");
            t = this.appConfig['Tracer'];
        } else throw 'BMS::readTracerConfig - no Tracer section defined';

        this.tracerInterval = 2000;
        if ('interval_sec' in t)
            this.tracerInterval = t.interval_sec * 1000;
        else logger.warn(`BMS::readTracerConfig - no Tracer interval_sec defined - using default ${this.tracerInterval}`);

        if ('isMaster' in t)
            this.isMaster = t.isMaster;
        else throw 'BMS::readTracerConfig - no Tracer isMaster defined';
    }

    readOpenWeatherConfig() {
        let w = null;
        if ('openWeatherAPI' in this.appConfig) {
            logger.info("BMS::readOpenWeatherConfig - reading openWeatherAPI");
            w = this.appConfig['openWeatherAPI'];
        } else throw 'BMS::readOpenWeatherConfig - no openWeatherAPI section defined';

        if ('key' in w && 'latitude' in w && 'longitude' in w)
            this.pvInput = new PVInputFromIrradianceML(ECMeter, w.latitude, w.longitude, w.key);
        else throw 'BMS::readOpenWeatherConfig - key, latitude and longitude mandatory';
    }

    protectFlows(time) {
        logger.trace("BMS::protectFlows");
        try {
            if (this.bottomBattProtectionLP) {
                this.bottomBattProtectionLP.setFlow(this.bottomFlow, time);
            }
            if (this.bottomBattProtectionHP) {
                this.bottomBattProtectionHP.setFlow(this.bottomFlow, time);
            }
            if (this.topBattProtectionLP) {
                this.topBattProtectionLP.setFlow(this.topFlow, time);
            }
            if (this.topBattProtectionHP) {
                this.topBattProtectionHP.setFlow(this.topFlow, time);
            }
            if (this.chargerProtectionLP) {
                this.chargerProtectionLP.setFlow(this.chargerFlow, time);
            }
            if (this.chargerProtectionHP) {
                this.chargerProtectionHP.setFlow(this.chargerFlow, time);
            }
            if (this.chargerLoadProtectionLP) {
                this.chargerLoadProtectionLP.setFlow(this.loadFlow, time);
            }
            if (this.chargerLoadProtectionHP) {
                this.chargerLoadProtectionHP.setFlow(this.loadFlow, time);
            }
            if (this.chargerOverheatProtectionHP) {
                this.chargerOverheatProtectionHP.setFlow(this.pvFlow, time);
            }
        }
        catch(err) {
            logger.error('BMS::protectFlows failed: ' + err);
        }
    }

    setFlows(changedMap) {
        logger.trace('BMS::setFlows');
        try {
            if (changedMap.has('midVoltage')) {
                // logger.debug('BMS::setFlows - midVoltage: ' +
                //              changedMap.get('midVoltage').newValue + ', ' +
                //              changedMap.get('midVoltage').value);
                this.bottomFlow.setVoltage(changedMap.get('midVoltage').newValue);
            }
            if (changedMap.has('topVoltage')) {
                // logger.debug('BMS::setFlows - topVoltage: ' +
                //              changedMap.get('topVoltage').newValue + ', ' +
                //              changedMap.get('topVoltage').value);
                this.topFlow.setVoltage(changedMap.get('topVoltage').newValue);
            }
            let batteryVoltage = -1;
            if (changedMap.has('upperVoltage')) {
                // logger.debug('BMS::setFlows - upperVoltage: ' +
                //              changedMap.get('upperVoltage').newValue + ', ' +
                //              changedMap.get('upperVoltage').value);
                batteryVoltage = changedMap.get('upperVoltage').newValue;
            }
            if (changedMap.has('MPPTbatteryVoltage')) {
                // upperVoltage and MPPTbatteryVoltage are the same from different devices
                if (batteryVoltage !== -1) // average
                    batteryVoltage = 0.5 * (changedMap.get('MPPTbatteryVoltage').newValue +
                                            batteryVoltage);
                else
                    batteryVoltage = changedMap.get('MPPTbatteryVoltage').newValue;
            }
            if (batteryVoltage !== -1) {
                this.chargerFlow.setVoltage(batteryVoltage);
                this.loadFlow.setVoltage(batteryVoltage);
            }
            if (changedMap.has('MPPTpvVoltage')) {
                this.pvFlow.setVoltage(changedMap.get('MPPTpvVoltage').newValue);
            }
            if (changedMap.has('batteryCurrent')) {
                // see explanation to class FloatChargeCharacteristic:
                // The current is measured across the 24V, i.e. it must be split
                // across the lower and upper accus packs of 12V, i.e. divided by 2:
                let current = changedMap.get('batteryCurrent').newValue * 0.5;
                this.bottomFlow.setCurrent(current);
                this.topFlow.setCurrent(current);
            }
            if (changedMap.has('MPPTchargingCurrent')) {
                let current = changedMap.get('MPPTchargingCurrent').newValue;
                this.chargerFlow.setCurrent(current);
                this.pvFlow.setCurrent(current);
            }
            if (changedMap.has('MPPTloadCurrent')) {
                // for consistency: everything out ot the battery
                // is negative. MPPTloadCurrent is positive, it does not quite come
                // out of the battery, yet it should be negative...
                this.loadFlow.setCurrent(-changedMap.get('MPPTloadCurrent').newValue);
            }
        }
        catch(err) {
            logger.error('BMS::setFlows failed: ' + err);
        }
    }
        
    setStates(changedMap, timeStamp) {
        logger.trace('BMS::setStates');
        if (! this.deviceProtection ) return;
        // should be filled with first call at registration of ChangeList
        let states =
            {
                relay: null,
                isCharging: null
            };
        try {
            if (changedMap.has('relayState'))
                states.relay = changedMap.get('relayState').newValue;
            if (changedMap.has('MPPTisCharging'))
                states.isCharging = changedMap.get('MPPTisCharging').newValue;
        
            if (changedMap.has('MPPTisOverload'))
                this.deviceProtection.setOverload(
                    changedMap.get('MPPTisOverload').newValue, timeStamp);
            if (changedMap.has('MPPTisShortcutLoad'))
                this.deviceProtection.setShortcutLoad(
                    changedMap.get('MPPTisShortcutLoad').newValue, timeStamp);
            if (changedMap.has('MPPTisBatteryOverload'))
                this.deviceProtection.setBatteryOverload(
                    changedMap.get('MPPTisBatteryOverload').newValue, timeStamp);
            if (changedMap.has('MPPTisFullIndicator'))
                this.deviceProtection.setBatteryFull(
                    changedMap.get('MPPTisFullIndicator').newValue, timeStamp);
            if (changedMap.has('MPPTisOverDischarge'))
                this.deviceProtection.setOverDischarge(
                    changedMap.get('MPPTisOverDischarge').newValue, timeStamp);
            if (changedMap.has('MPPTbatteryTemperature'))
                this.deviceProtection.setBatteryTemperature(
                    changedMap.get('MPPTbatteryTemperature').newValue, timeStamp);
            if (changedMap.has('alarmState'))
                this.deviceProtection.setMonitorAlarm(
                    changedMap.get('alarmState').newValue, timeStamp);
            if (changedMap.has('alarmReason'))
                this.deviceProtection.setAlarmReason(
                    changedMap.get('alarmReason').newValue, timeStamp);
        }
        catch(err) {
            logger.error('BMS::setStates failed: ' + err);
        }
        return states;
    }

    processData(changedMap, timeStamp) {
        logger.trace('BMS::processData');
        this.setFlows(changedMap);
        this.protectFlows(timeStamp);

        let UPv   = this.pvFlow.getVoltage();
        let UBat  = this.chargerFlow.getVoltage();
        let IPv   = this.pvFlow.getCurrent();
        let ILoad = this.loadFlow.getCurrent();
        let IBat  = this.topFlow.getCurrent() * 2;
        //logger.debug('BMS::processData - IPv = ' + IPv + ' IBat = ' + IBat);

        let relayState = ('relayState' in this.update() ? this.update().relayState.value : 'OFF'); // 'ON' or 'OFF'
        ECMeter.setFlows(UPv, UBat, IPv, ILoad, IBat, relayState, timeStamp);

        try {
            if (this.pvInput) {
                this.pvInput.setFlow(this.chargerFlow, timeStamp);
                if (changedMap.has('MPPTbatteryTemperature')) {
                    let temp = changedMap.get('MPPTbatteryTemperature').newValue;
                    this.pvInput.setTemp(temp, timeStamp);
                }
            }
            else {
                logger.warn('BMS::processData - pvInput not yet available');
                //pvInput = require( './forecast' ).pvInput;
            }
        }
        catch(err) {
            logger.error('pvInput.setFlow or pvInput.setTemp failed: ' + err);
        }

        if (this.usageBuckets)
            this.usageBuckets.logUsage(relayState, timeStamp);

        if (this.batteryProtection)
            this.batteryProtection.setVoltages(this.topFlow.getVoltage(),
                                               this.bottomFlow.getVoltage(),
                                               UPv);
        this.setStates(changedMap, timeStamp);
    }

    setAccuChainVoltage(newVoltage, oldVoltage, timeStamp, key) {
        logger.trace("BMS::setAccuChainVoltage");
        this.chargerFlow.setVoltage(newVoltage);
        this.loadFlow.setVoltage(newVoltage);

        // Overcharge cannot be controlled (no electronic switches).
        // It should be handled by the charger and battery balancer
        // the later of which balances the voltage (exactly) between
        // the two blocks in series.

        this.protectFlows();
    }

    // \param newCurrent, oldCurrent, timeStamp as string (need conversion to numbers)
    setCurrent(newCurrent, oldCurrent, timeStamp, key) {
        logger.trace("BMS::setCurrent");

        // see explanation to class FloatChargeCharacteristic:
        // The current is measured across the 24V, i.e. it must be split
        // across the lower and upper accus packs of 12V, i.e. divided by 2:
        let current = newCurrent * 0.5; // => SI units
        this.bottomFlow.setCurrent(current);
        this.topFlow.setCurrent(current);

        this.protectFlows();

        let time = timeStamp * 0.001; // converts from milliseconds to SI (seconds)
        //this.lowerIncCapacity.add(this.bottomFlow.getCurrent(), time);
        //this.upperIncCapacity.add(this.topFlow.getCurrent(), time);

        let lCurrent = this.bottomFlow.getCurrent();
        // FIXME: soc and lCurrent are local variables an not exposed anywhere ==> useless. what was the purpose???
        let soc = 0;
        if (Math.abs(lCurrent) < 0.01) { // absolute less than 10mA
            soc = this.lowerRestingC.getSOC(this.bottomFlow);
            let lowerC = 0; //this.accumulator.getCapacityInAh(soc) + this.lowerIncCapacity.getLowerIntegral() * scaleSecondsToHours;
            let upperC = 0; //this.accumulator.getCapacityInAh(soc) + this.lowerIncCapacity.getUpperIntegral() * scaleSecondsToHours;
            //console.log("lower C(rest): [" + lowerC + ", " + upperC + "]");
        }
        if (lCurrent > 0 && this.lowerFloatC) {
            soc = this.lowerFloatC.getSOC(this.bottomFlow);
        }
        else if (lCurrent < 0 && this.lowerDischargeC) {
            soc = this.lowerDischargeC.getSOC(this.bottomFlow);
        }
    }

    getLowerSOC() {
        if (!this.lowerFloatC) return 0;
        return this.lowerFloatC.getSOC(this.bottomFlow);
    }

    getUpperSOC() {
        if (!this.upperFloatC) return 0;
        return this.upperFloatC.getSOC(this.topFlow);
    }

    listAlarms() {
        if (this.alarms)
            return this.alarms.persistPlain('\t');
        else return "\x1b[1m\x1b[31mNo Alarm History\x1b[0m";
    }

    createMPPTobjects() {
        let bmvdata = this.update();

        bmvdata.MPPTbatteryVoltage     = this.createObject(1,  "V", "MPPT Batt. Voltage");
        bmvdata.MPPTpvVoltage          = this.createObject(1,  "V", "MPPT PV Voltage");
        bmvdata.MPPTloadCurrent        = this.createObject(1,  "A", "MPPT Load Current");
        bmvdata.MPPTisOverload         = this.createObject(0,  "", "MPPT Overloaded");
        bmvdata.MPPTisShortcutLoad     = this.createObject(0,  "", "MPPT Load Shortcut");
        bmvdata.MPPTisBatteryOverload  = this.createObject(0,  "", "MPPT Batt. Overloaded");
        bmvdata.MPPTisOverDischarge    = this.createObject(0,  "", "MPPT Over Discharged");
        bmvdata.MPPTisFullIndicator    = this.createObject(0,  "", "MPPT Batt. Full");
        bmvdata.MPPTisCharging         = this.createObject(0,  "", "MPPT Charging");
        bmvdata.MPPTbatteryTemperature = this.createObject(1,  "°C", "MPPT Batt. Temp.");
        bmvdata.MPPTchargingCurrent    = this.createObject(1,  "A", "MPPT Charge Current");
    }
}


module.exports.BMSInstance = new BMS();
