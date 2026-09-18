/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.networkgenerator;

import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.networkgenerator.CartNetworkGenerator;
import com.hitachi.warehouse.mapmaker.networkgenerator.GenerateInterruptException;
import com.hitachi.warehouse.model.map.MapProxy;
import com.hitachi.warehouse.model.map.WaypointGraph;
import com.hitachi.warehouse.model.map.WorldMap;
import java.util.ArrayList;
import java.util.List;

public class NetworkCalculatorManager
extends Thread {
    private boolean AutoCalculation_ON = true;
    private boolean calculationCheck_run = true;
    private boolean calculationStop = false;
    private boolean isInterrupt;
    private String isErrorInfo;
    MapMaker mapMaker;
    private boolean keepRunning = true;
    private Object lock = new Object();
    private boolean needsRecalc = false;
    private boolean isCalculating = false;
    private boolean isCatchMemoryError = false;
    private boolean needsInterrupt = false;
    private List<NetworkCalculatorManagerListener> listeners = new ArrayList<NetworkCalculatorManagerListener>();
    private WorldMap map;
    private boolean needsAllShelvesToBeAccessible = true;
    public CartNetworkGenerator generator;

    public boolean getExecuteCalc() {
        return this.AutoCalculation_ON;
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void changeExecuteCalc() {
        boolean bl = this.AutoCalculation_ON = !this.AutoCalculation_ON;
        if (!this.AutoCalculation_ON && this.generator.isRunning()) {
            this.needsInterrupt = true;
            this.recalc();
        }
        Object object = this.lock;
        synchronized (object) {
            this.lock.notifyAll();
        }
    }

    public boolean getCalculationCheck_run() {
        return this.calculationCheck_run;
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void setCalculationCheck_run(boolean calculationCheck_run) {
        this.calculationCheck_run = calculationCheck_run;
        if (calculationCheck_run) {
            if (this.mapMaker.getWaypointsCheckManager() != null) {
                this.mapMaker.getWaypointsCheckManager().getWaypointsCheckFrame().setGraph(null);
            }
            try {
                this.map.startWrite();
                this.map.setCartGraph(null);
            }
            finally {
                this.map.endWrite();
            }
        }
        Object object = this.lock;
        synchronized (object) {
            this.lock.notifyAll();
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void setCalculationStop(boolean calculationStop) {
        this.calculationStop = calculationStop;
        Object object = this.lock;
        synchronized (object) {
            this.lock.notifyAll();
        }
    }

    public boolean isInterrupt() {
        return this.isInterrupt;
    }

    public void setIsInterrupt(boolean isInterrupt) {
        this.isInterrupt = isInterrupt;
    }

    public String isErrorInfo() {
        return this.isErrorInfo;
    }

    public void setIsErrorInfo(String isErrorInfo) {
        this.isErrorInfo = isErrorInfo;
    }

    public String isWarningErrorInfo(boolean all) {
        if (this.generator.getWarningErrorInfo() == null) {
            return null;
        }
        if (this.generator.getWarningErrorInfo().size() == 0) {
            return null;
        }
        String message = "";
        if (all) {
            for (String warningErrorInfo : this.generator.getWarningErrorInfo()) {
                message = String.valueOf(message) + warningErrorInfo + "\n";
            }
        } else {
            message = this.generator.getWarningErrorInfo().get(0);
        }
        return message;
    }

    public NetworkCalculatorManager(MapProxy parent, MapMaker mapMaker) {
        this.mapMaker = mapMaker;
        parent.addMapChangedListener(new WorldMap.WorldMapChangedListener(){

            @Override
            public void mapChanged(WorldMap map) {
                NetworkCalculatorManager.this.recalc();
            }
        });
    }

    public void kill() {
        this.keepRunning = false;
    }

    public void setGeneratorNeedsInterrupt(boolean needsInterrupt) {
        this.needsInterrupt = needsInterrupt;
    }

    public boolean isCalculating() {
        return this.isCalculating;
    }

    public boolean isNeedsRecalc() {
        return this.needsRecalc;
    }

    public void setNeedsRecalc(boolean needsRecalc) {
        this.needsRecalc = needsRecalc;
    }

    public boolean isCatchMemoryError() {
        return this.isCatchMemoryError;
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void recalc() {
        Object object = this.lock;
        synchronized (object) {
            this.needsRecalc = true;
            if (this.isCalculating) {
                this.needsInterrupt = true;
            }
            if (this.mapMaker.getWaypointsCheckManager() != null && this.mapMaker.getWaypointsCheckManager().getWaypointsCheckFrame() != null) {
                this.mapMaker.getWaypointsCheckManager().getWaypointsCheckFrame().setGraph(null);
            }
            try {
                this.map.startWrite();
                this.map.setCartGraph(null);
            }
            finally {
                this.map.endWrite();
            }
            this.lock.notifyAll();
        }
    }

    public void setMap(WorldMap map) {
        this.map = map;
        this.recalc();
    }

    public void setMapNoRecalc(WorldMap map) {
        this.map = map;
    }

    public void setNeedsAllShelvesToBeAccessible(boolean set) {
        this.needsAllShelvesToBeAccessible = set;
    }

    protected void doCalc() {
        System.out.println("start calc");
        try {
            this.isInterrupt = false;
            this.isCalculating = true;
            final WorldMap map = this.map;
            if (map != null) {
                try {
                    this.generator = new CartNetworkGenerator(this.mapMaker.worldMapMultiFloor.getFloorNoforWorldMap(map), map);
                    this.generator.setNeedsAllShelvesToBeAccessible(this.needsAllShelvesToBeAccessible);
                    this.generator.addListener(new CartNetworkGenerator.NetworkGeneratorListener(){

                        @Override
                        public void generateFinished(WaypointGraph graph, String errorInfo) {
                            NetworkCalculatorManager.this.isErrorInfo = errorInfo;
                            NetworkCalculatorManager.this.isCatchMemoryError = NetworkCalculatorManager.this.generator.isCatchMemoryError();
                            if (errorInfo == null) {
                                try {
                                    map.startWrite();
                                    map.setCartGraph(graph);
                                }
                                finally {
                                    map.endWrite();
                                }
                            }
                            try {
                                map.startWrite();
                                map.setCartGraph(null);
                            }
                            finally {
                                map.endWrite();
                            }
                            if (!NetworkCalculatorManager.this.isInterrupt) {
                                NetworkCalculatorManager.this.mapMaker.mapFrame.mapView.setMessage("couldn't create graph: [" + errorInfo + "]");
                            }
                            for (NetworkCalculatorManagerListener listener : NetworkCalculatorManager.this.listeners) {
                                listener.generateFinished(graph);
                            }
                        }

                        @Override
                        public void checkInterrupt() throws GenerateInterruptException {
                            if (NetworkCalculatorManager.this.needsInterrupt) {
                                NetworkCalculatorManager.this.needsInterrupt = false;
                                NetworkCalculatorManager.this.isInterrupt = true;
                                throw new GenerateInterruptException("経路キャッシュ計算を中断しました。");
                            }
                        }
                    });
                    this.generator.run();
                }
                catch (Exception e) {
                    e.printStackTrace();
                }
            }
        }
        finally {
            this.isCalculating = false;
            System.out.println("calc finished [needsRecalc = " + this.needsRecalc + ", isCalculating = " + this.isCalculating + "]");
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    @Override
    public void run() {
        try {
            boolean lockon = false;
            while (this.keepRunning) {
                boolean doRecalc = false;
                Object object = this.lock;
                synchronized (object) {
                    if (this.calculationStop) {
                        lockon = true;
                    }
                    if (this.AutoCalculation_ON) {
                        if (!this.needsRecalc) {
                            lockon = true;
                        }
                    } else if (!this.calculationCheck_run) {
                        lockon = true;
                    }
                    if (lockon) {
                        this.lock.wait();
                        lockon = false;
                    }
                    if (this.calculationCheck_run) {
                        this.calculationCheck_run = false;
                        this.needsRecalc = false;
                        doRecalc = true;
                    }
                    if (this.AutoCalculation_ON && this.needsRecalc) {
                        this.needsRecalc = false;
                        doRecalc = true;
                    }
                    if (this.calculationStop) {
                        doRecalc = false;
                    }
                }
                if (!doRecalc) continue;
                this.doCalc();
            }
        }
        catch (Exception e) {
            e.printStackTrace();
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void addListener(NetworkCalculatorManagerListener listener) {
        List<NetworkCalculatorManagerListener> list = this.listeners;
        synchronized (list) {
            this.listeners.add(listener);
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void removeListener(NetworkCalculatorManagerListener listener) {
        List<NetworkCalculatorManagerListener> list = this.listeners;
        synchronized (list) {
            this.listeners.remove(listener);
        }
    }

    public static interface NetworkCalculatorManagerListener {
        public void generateFinished(WaypointGraph var1);
    }
}

