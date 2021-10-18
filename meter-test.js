const ECMeter = require( './meter' ).EnergyAndChargeMeter;


const oneHourInMs = 1000 * 60 * 60;



//ECMeter.setFlows(UPv, UBat, IPv, ILoad, IBat, relayState, timeStamp);

//ECMeter.setStart(idx)

var idx = 0;
function setUp() {
    idx = ECMeter.setStart();
    // must be after setStart()
    ECMeter.resetAccumulations();
}


function testEDirectUseAccumulatesUBat_x_IPvWhenOFF() {

    // test with relay OFF
    const UBat = 1; // V

    // Day charging (relay OFF)
    // IPv > IBat > 0 && IPv > ILoad ==> directUse current = ILoad
    setUp();
    let hours = 10;
    let IPv  = 5;
    let IBat = 4;
    // relay OFF => all IPv goes into ILoad,
    //              because battery is charging (IBat > 0)
    let ILoad = -(IPv - IBat); // relay OFF => IPv splits into IBat and ILoad
    let now = Date.now();
    // after initialization this.lastTime === 0 and the first 
    // accumulation is skipped ==> add a loop at the start
    for (ts = 0; ts <= hours; ++ts) {
        ECMeter.setFlows(0, UBat, IPv, ILoad, IBat, 'OFF', now + ts * oneHourInMs);
    }
    // FIXME: how to "remote set" Date.now()?
    if (ECMeter.meter.EWMs.directUse === UBat * (-ILoad) * hours * oneHourInMs) {
        console.log("testDirectUse IPv > IBat > 0: PASS");
        console.log(ECMeter.meter.EWMs.directUse);
        console.log(UBat * (-ILoad) * hours * oneHourInMs);
    }
    else {
        console.log("testDirectUse IPv > IBat > 0: FAIL");
        console.log(ECMeter.meter.EWMs.directUse);
        console.log(UBat * (-ILoad) * hours * oneHourInMs);
    }
    
    // Day charging (relay OFF)
    // IPv > IBat > 0 && IPv < ILoad ==> directUse current = IPv
    // relay OFF => all IPv via ILoad path into devices,
    //              but only the IPv part is direct used.
    //              The remaining current comes out of the
    //              battery => IBat < 0
    // ==> this case cannot exist

    // Day charging (relay ON)
    // IPv > IBat > 0 && IPv > ILoad ==> directUse current = ILoad
    setUp();
    hours = 10;
    IPv  = 25;
    IBat = 4;
    // relay ON => all IPv goes into ILoad, and IPv - IBat
    //             goes directly to device
    ILoad = -2; // relay ON => IPv splits into IBat and ILoad
    now = Date.now();
    ECMeter.lastTime = 0;
    // after initialization this.lastTime === 0 and the first 
    // accumulation is skipped ==> add a loop at the start
    for (ts = 0; ts <= hours; ++ts) {
        ECMeter.setFlows(0, UBat, IPv, ILoad, IBat, 'ON', now + ts * oneHourInMs);
    }
    // FIXME: how to "remote set" Date.now()?
    if (ECMeter.meter.EWMs.directUse === UBat * (IPv - IBat) * hours * oneHourInMs) {
        console.log("testDirectUse IPv > IBat > 0: PASS");
        console.log(ECMeter.meter.EWMs.directUse);
        console.log(UBat * (IPv - IBat) * hours * oneHourInMs);
    }
    else {
        console.log("testDirectUse IPv > IBat > 0: FAIL");
        console.log(ECMeter.meter.EWMs.directUse);
        console.log(UBat * (IPv - IBat) * hours * oneHourInMs);
    }

    return; // FIXME: tmp
    
    // Day charging (relay ON)
    // IPv > IBat > 0
    setUp();
    hours = 10;
    IPv  = 10;
    IBat = 2;
    // relay OFF => all IPv goes into ILoad,
    //              because battery is charging (IBat > 0)
    ILoad = -1; // relay ON
    now = Date.now();
    newBase = ECMeter.meter.EWMs.directUse;
    // after initialization this.lastTime === 0 and the first 
    // accumulation is skipped ==> add a loop at the start
    for (ts = 0; ts <= hours; ++ts) {
        ECMeter.setFlows(0, UBat, IPv, ILoad, IBat, 'ON', now + ts * oneHourInMs);
    }
    // FIXME: how to "remote set" Date.now()?
    if (ECMeter.meter.EWMs.directUse - newBase
        === UBat * (IPv - IBat - ILoad) * hours * oneHourInMs)
        console.log("testDirectUse IPv > IBat > 0: PASS");
    else {
        console.log("testDirectUse IPv > IBat > 0: FAIL");
        console.log(ECMeter.meter.EWMs.directUse);
        console.log(UBat * (IPv - IBat - ILoad) * hours * oneHourInMs);
    }
    
    // Day discharging
    // IPv > 0 > IBat
    setUp();
    IPv  = 2;
    IBat = -3;
    ILoad = -IPv; // relay OFF => all IPv goes into ILoad
    hours = 10;
    now = Date.now();
    newBase = ECMeter.meter.EWMs.directUse;
    for (ts = 0; ts < hours; ts += oneHourInMs) {
        ECMeter.setFlows(0, UBat, IPv, ILoad, IBat, 'OFF', now * ts * oneHourInMs);
    }
    if (ECMeter.meter.EWMs.directUse - newBase === UBat * IPv * hours * oneHourInMs)
        console.log("testDirectUse IPv > IBat > 0: PASS");
    else {
        console.log("testDirectUse IPv > IBat > 0: FAIL");
        console.log(ECMeter.meter.EWMs.directUse);
        console.log(hours * oneHourInMs);
    }


    // Night discharging
    // 0 > IBat, 0 = IPv

    // Night discharging
    // 0 > IBat, 0 > IPv


    
    // if on:
    //             this.meter.EWMs.directUse += this.UBat * Math.max(this.IPv - IBat, 0) * timeDiff;
    // else:
    //             this.meter.EWMs.directUse +=
    //              this.UBat * Math.min(Math.max(0, this.IPv), Math.max(0, -this.ILoad)) * timeDiff;

    
    // use
    // ECMeter.UPv    = UPv;
    // ECMeter.UBat   = UBat;
    // ECMeter.IPv    = IPv;
    // ECMeter.ILoad  = ILoad;
    // ECMeter.IBat   = IBat;
    // ECMeter.RState = relayState;
    // ECMeter.lastTime = time;

}


// ECMeter.getEDirectUse(idx)
// ECMeter.getELowVoltUse(idx)
// ECMeter.getEAbsorbed(idx)
// ECMeter.getEDrawn(idx)
// ECMeter.getEUsed(idx)
// ECMeter.toEuroInclVAT(energyInWh)
// ECMeter.getELoss1(idx)
// ECMeter.getELoss2(idx)
// ECMeter.getCAbsorbed(idx)
// ECMeter.getCDrawn(idx)
// ECMeter.getCLevel(idx)
// ECMeter.getOnTimeInMs(idx)


testEDirectUseAccumulatesUBat_x_IPvWhenOFF();
