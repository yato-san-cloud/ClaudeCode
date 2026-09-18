/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker;

import com.hitachi.warehouse.model.map.WorldMap;
import java.io.Serializable;

public class WorldMapExtension
implements Serializable {
    private static final long serialVersionUID = -8268453201122970038L;
    private WorldMap worldMap;
    private String name;
    private double centerX;
    private double centerY;
    private double zoomLevel;

    public WorldMapExtension(WorldMap worldMap, String name, double centerX, double centerY, double zoomLevel) {
        this.worldMap = worldMap;
        this.name = name;
        this.centerX = centerX;
        this.centerY = centerY;
        this.zoomLevel = zoomLevel;
    }

    public WorldMap getWorldMap() {
        return this.worldMap;
    }

    public void setWorldMap(WorldMap worldMap) {
        this.worldMap = worldMap;
    }

    public String getName() {
        return this.name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public double getCenterX() {
        return this.centerX;
    }

    public void setCenterX(double centerX) {
        this.centerX = centerX;
    }

    public double getCenterY() {
        return this.centerY;
    }

    public void setCenterY(double centerY) {
        this.centerY = centerY;
    }

    public double getZoomLevel() {
        return this.zoomLevel;
    }

    public void setZoomLevel(double zoomLevel) {
        this.zoomLevel = zoomLevel;
    }
}

