/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.importers;

import com.hitachi.warehouse.bms.model.Beacon;
import com.hitachi.warehouse.mapmaker.Constants;
import com.hitachi.warehouse.mapmaker.MapMakerUtils;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractPointObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import com.hitachi.warehouse.model.map.objects.BeaconObject;
import com.hitachi.warehouse.model.map.objects.ConstrainedAreaObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import com.hitachi.warehouse.model.map.objects.ImageObject;
import com.hitachi.warehouse.model.map.objects.StairsObject;
import com.hitachi.warehouse.model.map.objects.StationObject;
import com.hitachi.warehouse.model.map.objects.WallObject;
import com.hitachi.warehouse.model.picking.FreeShelfArea;
import java.awt.Color;
import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import javax.imageio.ImageIO;

public class MapCsvImporter {
    private static final int CMN_COLUMN_NO_TYPE = 0;
    private static final String DELIMITER = ",";
    private static final String ENCODING = "UTF-8";
    private static final ArrayList<Constants.MapCsvObjType> RECTANGLE_TYPES = new ArrayList();
    private static final ArrayList<Constants.MapCsvObjType> POINT_TYPES = new ArrayList();
    private boolean existsMetaBBox;

    public MapCsvImporter() {
        RECTANGLE_TYPES.add(Constants.MapCsvObjType.SHELF);
        RECTANGLE_TYPES.add(Constants.MapCsvObjType.WALL);
        RECTANGLE_TYPES.add(Constants.MapCsvObjType.STATION);
        RECTANGLE_TYPES.add(Constants.MapCsvObjType.CONSTRAINED_AREA);
        RECTANGLE_TYPES.add(Constants.MapCsvObjType.STAIRS);
        Collections.unmodifiableList(RECTANGLE_TYPES);
        POINT_TYPES.add(Constants.MapCsvObjType.BEACON);
        Collections.unmodifiableList(POINT_TYPES);
        this.existsMetaBBox = false;
    }

    public void importFile(WorldMap map, File f2) throws IOException {
        BufferedReader reader = null;
        double left = Double.MAX_VALUE;
        double top = Double.MAX_VALUE;
        double bottom = 0.0;
        double right = 0.0;
        this.existsMetaBBox = false;
        try {
            reader = new BufferedReader(new InputStreamReader((InputStream)new FileInputStream(f2), ENCODING));
            while (reader.ready()) {
                String readLine = reader.readLine();
                if (readLine == null) continue;
                String[] columns = readLine.split(DELIMITER, -1);
                Constants.MapCsvDataType dataType = MapMakerUtils.fromOrdinal(Constants.MapCsvDataType.class, Byte.parseByte(columns[0]));
                switch (dataType) {
                    case META: {
                        this.setMeta(map, columns);
                        break;
                    }
                    case OBJ: {
                        AbstractObject object = this.createAbstractObject(columns);
                        if (object == null) break;
                        try {
                            map.startWrite();
                            map.add(object);
                        }
                        finally {
                            map.endWrite();
                        }
                        if (left > object.boundTL().x) {
                            left = object.boundTL().x;
                        }
                        if (right < object.boundBR().x) {
                            right = object.boundBR().x;
                        }
                        if (top > object.boundTL().y) {
                            top = object.boundTL().y;
                        }
                        if (!(bottom < object.boundBR().y)) break;
                        bottom = object.boundBR().y;
                        break;
                    }
                }
            }
        }
        finally {
            if (reader != null) {
                try {
                    reader.close();
                }
                catch (IOException e) {
                    e.printStackTrace();
                }
            }
        }
        if (!this.existsMetaBBox) {
            double width = right - left;
            double height = bottom - top;
            map.setBounds(new Coord(left -= width * 0.05, top -= height * 0.05), new Coord(right += width * 0.05, bottom += height * 0.05));
        }
    }

    private void setMeta(WorldMap map, String[] columns) throws IOException {
        Constants.MapCsvMetaType metaType = MapMakerUtils.fromOrdinal(Constants.MapCsvMetaType.class, Integer.parseInt(columns[MetaColumns.META_TYPE.ordinal()]));
        switch (metaType) {
            case BBOX: {
                double left = Double.parseDouble(columns[BBoxColumns.LEFT.ordinal()]);
                double top = Double.parseDouble(columns[BBoxColumns.TOP.ordinal()]);
                double right = Double.parseDouble(columns[BBoxColumns.RIGHT.ordinal()]);
                double bottom = Double.parseDouble(columns[BBoxColumns.BOTTOM.ordinal()]);
                map.setBounds(new Coord(left, top), new Coord(right, bottom));
                this.existsMetaBBox = true;
                break;
            }
            case BG_IMG: {
                double left = Double.parseDouble(columns[BgImgColumns.LEFT.ordinal()]);
                double top = Double.parseDouble(columns[BgImgColumns.TOP.ordinal()]);
                double right = Double.parseDouble(columns[BgImgColumns.RIGHT.ordinal()]);
                double bottom = Double.parseDouble(columns[BgImgColumns.BOTTOM.ordinal()]);
                BufferedImage bufferedImage = ImageIO.read(new ByteArrayInputStream(Base64.getDecoder().decode(columns[BgImgColumns.BINARY.ordinal()])));
                map.setBounds(new Coord(left, top), new Coord(right, bottom));
                ImageObject imageObject = new ImageObject();
                imageObject.setBounds(new Coord(left, top), new Coord(right, bottom));
                imageObject.setImage(bufferedImage);
                map.setBGImg(imageObject);
                break;
            }
            case SHELF_NAME_LIST: {
                ArrayList<String> names = new ArrayList<String>();
                int i = ShelfNameList.FIRST_SHELF_NAME.ordinal();
                while (i < columns.length) {
                    names.add(columns[i]);
                    ++i;
                }
                map.shelfNameManager().setNames(names);
                break;
            }
        }
    }

    public AbstractObject createAbstractObject(String[] columns) {
        Constants.MapCsvObjType objType = MapMakerUtils.fromOrdinal(Constants.MapCsvObjType.class, Integer.parseInt(columns[ObjColumns.OBJ_TYPE.ordinal()]));
        if (RECTANGLE_TYPES.contains((Object)objType)) {
            return this.createAbstractRectangleObject(objType, columns);
        }
        if (POINT_TYPES.contains((Object)objType)) {
            return this.createAbstractPointObject(objType, columns);
        }
        return null;
    }

    public AbstractRectangleObject createAbstractRectangleObject(Constants.MapCsvObjType objType, String[] columns) {
        Coord tl = new Coord(Double.parseDouble(columns[RectangleColumns.LEFT.ordinal()]), Double.parseDouble(columns[RectangleColumns.TOP.ordinal()]));
        Coord br = new Coord(Double.parseDouble(columns[RectangleColumns.RIGHT.ordinal()]), Double.parseDouble(columns[RectangleColumns.BOTTOM.ordinal()]));
        switch (objType) {
            case SHELF: {
                return this.createFreeShelfObject(columns, tl, br);
            }
            case WALL: {
                return this.createWallObject(columns, tl, br);
            }
            case STATION: {
                return this.createStationObject(columns, tl, br);
            }
            case CONSTRAINED_AREA: {
                return this.createConstrainedArea(columns, tl, br);
            }
            case STAIRS: {
                return this.createStairsObject(columns, tl, br);
            }
        }
        return null;
    }

    public AbstractPointObject createAbstractPointObject(Constants.MapCsvObjType objType, String[] columns) {
        Coord coord = new Coord(Double.parseDouble(columns[PointColumns.COORD_X.ordinal()]), Double.parseDouble(columns[PointColumns.COORD_Y.ordinal()]));
        switch (objType) {
            case BEACON: {
                return this.createBeaconObject(columns, coord);
            }
        }
        return null;
    }

    public FreeShelfObject createFreeShelfObject(String[] columns, Coord tl, Coord br) {
        String name = columns[ShelfColumns.NAME.ordinal()];
        int alpha = Integer.valueOf(columns[ShelfColumns.COLOR_ALPHA.ordinal()]);
        int red = Integer.valueOf(columns[ShelfColumns.COLOR_RED.ordinal()]);
        int green = Integer.valueOf(columns[ShelfColumns.COLOR_GREEN.ordinal()]);
        int blue = Integer.valueOf(columns[ShelfColumns.COLOR_BLUE.ordinal()]);
        int arbg = (alpha << 24) + (red << 16) + (green << 8) + (blue << 0);
        Color color = new Color(arbg, true);
        FreeShelfObject shelfObject = new FreeShelfObject();
        shelfObject.setShelf(new FreeShelfArea(name));
        shelfObject.setBounds(tl, br);
        shelfObject.setShelfColor(color);
        return shelfObject;
    }

    public WallObject createWallObject(String[] columns, Coord tl, Coord br) {
        double height = Double.parseDouble(columns[WallColumns.HEIGHT.ordinal()]);
        WallObject wallObject = new WallObject();
        wallObject.setBounds(tl, br);
        wallObject.setHeight(height);
        return wallObject;
    }

    public StationObject createStationObject(String[] columns, Coord tl, Coord br) {
        StationObject stationObject = new StationObject();
        stationObject.setBounds(tl, br);
        return stationObject;
    }

    public ConstrainedAreaObject createConstrainedArea(String[] columns, Coord tl, Coord br) {
        byte orientation = Byte.parseByte(columns[ConstrainedAreaColumns.ORIENTATION.ordinal()]);
        byte trafficDirection = Byte.parseByte(columns[ConstrainedAreaColumns.TRAFFIC_DIRECTION.ordinal()]);
        double splitPosition = Double.parseDouble(columns[ConstrainedAreaColumns.SPLIT_POSITION.ordinal()]);
        boolean enterAExitA = Byte.parseByte(columns[ConstrainedAreaColumns.ENTRY_EXIT_CONSTRAINT_A_TO_A.ordinal()]) == 1;
        boolean enterAExitB = Byte.parseByte(columns[ConstrainedAreaColumns.ENTRY_EXIT_CONSTRAINT_A_TO_B.ordinal()]) == 1;
        boolean enterBExitA = Byte.parseByte(columns[ConstrainedAreaColumns.ENTRY_EXIT_CONSTRAINT_B_TO_A.ordinal()]) == 1;
        boolean enterBExitB = Byte.parseByte(columns[ConstrainedAreaColumns.ENTRY_EXIT_CONSTRAINT_B_TO_B.ordinal()]) == 1;
        ConstrainedAreaObject areaObject = new ConstrainedAreaObject();
        areaObject.setBounds(tl, br);
        areaObject.setOrientation(orientation);
        areaObject.setTrafficDirection(trafficDirection);
        areaObject.setSplitPosition(splitPosition);
        areaObject.setEnterAExitA(enterAExitA);
        areaObject.setEnterAExitB(enterAExitB);
        areaObject.setEnterBExitA(enterBExitA);
        areaObject.setEnterBExitB(enterBExitB);
        return areaObject;
    }

    public BeaconObject createBeaconObject(String[] columns, Coord coord) {
        String id = columns[BeaconColumns.ID.ordinal()];
        String name = columns[BeaconColumns.NAME.ordinal()];
        BeaconObject beaconObject = new BeaconObject();
        Beacon beacon = new Beacon(id, name);
        beaconObject.setBeacon(beacon);
        beacon.setCoord(coord);
        return beaconObject;
    }

    public StairsObject createStairsObject(String[] columns, Coord tl, Coord br) {
        String name = columns[StairsColumns.NAME.ordinal()];
        StairsObject stairsObject = new StairsObject();
        stairsObject.setName(name);
        stairsObject.setBounds(tl, br);
        return stairsObject;
    }

    private static enum BBoxColumns {
        DATA_TYPE,
        META_TYPE,
        LEFT,
        TOP,
        RIGHT,
        BOTTOM;

    }

    private static enum BeaconColumns {
        DATA_TYPE,
        OBJ_TYPE,
        COORD_X,
        COORD_Y,
        ID,
        NAME;

    }

    private static enum BgImgColumns {
        DATA_TYPE,
        META_TYPE,
        LEFT,
        TOP,
        RIGHT,
        BOTTOM,
        BINARY;

    }

    private static enum ConstrainedAreaColumns {
        DATA_TYPE,
        OBJ_TYPE,
        LEFT,
        TOP,
        RIGHT,
        BOTTOM,
        ORIENTATION,
        TRAFFIC_DIRECTION,
        SPLIT_POSITION,
        ENTRY_EXIT_CONSTRAINT_A_TO_A,
        ENTRY_EXIT_CONSTRAINT_A_TO_B,
        ENTRY_EXIT_CONSTRAINT_B_TO_A,
        ENTRY_EXIT_CONSTRAINT_B_TO_B;

    }

    private static enum MetaColumns {
        DATA_TYPE,
        META_TYPE;

    }

    private static enum ObjColumns {
        DATA_TYPE,
        OBJ_TYPE;

    }

    private static enum PointColumns {
        DATA_TYPE,
        OBJ_TYPE,
        COORD_X,
        COORD_Y;

    }

    private static enum RectangleColumns {
        DATA_TYPE,
        OBJ_TYPE,
        LEFT,
        TOP,
        RIGHT,
        BOTTOM;

    }

    private static enum ShelfColumns {
        DATA_TYPE,
        OBJ_TYPE,
        LEFT,
        TOP,
        RIGHT,
        BOTTOM,
        NAME,
        COLOR_ALPHA,
        COLOR_RED,
        COLOR_GREEN,
        COLOR_BLUE;

    }

    private static enum ShelfNameList {
        DATA_TYPE,
        META_TYPE,
        FIRST_SHELF_NAME;

    }

    private static enum StairsColumns {
        DATA_TYPE,
        OBJ_TYPE,
        LEFT,
        TOP,
        RIGHT,
        BOTTOM,
        NAME;

    }

    private static enum StationColumns {
        DATA_TYPE,
        OBJ_TYPE,
        LEFT,
        TOP,
        RIGHT,
        BOTTOM;

    }

    private static enum WallColumns {
        DATA_TYPE,
        OBJ_TYPE,
        LEFT,
        TOP,
        RIGHT,
        BOTTOM,
        HEIGHT;

    }
}

