/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.exporters;

import com.hitachi.warehouse.gui.mapframe.MapFrame;
import com.hitachi.warehouse.mapmaker.Constants;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.ShelfNameManager;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.BeaconObject;
import com.hitachi.warehouse.model.map.objects.ConstrainedAreaObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import com.hitachi.warehouse.model.map.objects.ImageObject;
import com.hitachi.warehouse.model.map.objects.StairsObject;
import com.hitachi.warehouse.model.map.objects.StationObject;
import com.hitachi.warehouse.model.map.objects.WallObject;
import common.file.FileChooser;
import common.mutable.Mutable;
import java.awt.image.RenderedImage;
import java.io.BufferedWriter;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.lang.reflect.InvocationTargetException;
import java.util.Base64;
import javax.imageio.ImageIO;
import javax.swing.JOptionPane;
import javax.swing.SwingUtilities;

public class MapCsvExporter {
    private static final String ENCODING = "UTF-8";

    public void exportFile(MapFrame mapFrame, File orgRmpFile) {
        block23: {
            WorldMap map = mapFrame.mapView.map();
            System.out.println("exporter started");
            File outFile = this.chooseFile(orgRmpFile);
            if (outFile == null) {
                return;
            }
            if (outFile.exists() && JOptionPane.showConfirmDialog(mapFrame, outFile + "は既に存在します。上書きしますか？", "警告", 2) != 0) {
                return;
            }
            File parentDir = outFile.getParentFile();
            if (!parentDir.exists() && !parentDir.mkdirs()) {
                System.out.println("cannot create file.");
                return;
            }
            BufferedWriter writer = null;
            try {
                try {
                    writer = new BufferedWriter(new OutputStreamWriter((OutputStream)new FileOutputStream(outFile), ENCODING));
                    this.writeMeta(writer, map);
                    for (AbstractObject object : map.objects()) {
                        if (FreeShelfObject.class.isInstance(object)) {
                            this.writeShelf(writer, object);
                            continue;
                        }
                        if (StationObject.class.isInstance(object)) {
                            this.writeStation(writer, object);
                            continue;
                        }
                        if (BeaconObject.class.isInstance(object)) {
                            this.writeBeacon(writer, object);
                            continue;
                        }
                        if (WallObject.class.isInstance(object)) {
                            this.writeWall(writer, object);
                            continue;
                        }
                        if (ConstrainedAreaObject.class.isInstance(object)) {
                            this.writeConstrainedArea(writer, object);
                            continue;
                        }
                        if (!StairsObject.class.isInstance(object)) continue;
                        this.writeStairs(writer, object);
                    }
                }
                catch (IOException e) {
                    e.printStackTrace();
                    if (writer != null) {
                        try {
                            writer.close();
                        }
                        catch (IOException e2) {
                            e2.printStackTrace();
                        }
                    }
                    break block23;
                }
            }
            catch (Throwable throwable) {
                if (writer != null) {
                    try {
                        writer.close();
                    }
                    catch (IOException e) {
                        e.printStackTrace();
                    }
                }
                throw throwable;
            }
            if (writer != null) {
                try {
                    writer.close();
                }
                catch (IOException e) {
                    e.printStackTrace();
                }
            }
        }
        System.out.println("exporter finished.");
    }

    private File chooseFile(final File orgRmpFile) {
        File outFile = null;
        final Mutable box = new Mutable();
        try {
            final FileChooser chooser = new FileChooser();
            SwingUtilities.invokeAndWait(new Runnable(){

                @Override
                public void run() {
                    if (orgRmpFile == null) {
                        box.set(chooser.requestFileLocation("csv"));
                    } else {
                        String rmpFileName = orgRmpFile.getName();
                        String csvFileName = String.valueOf(rmpFileName.substring(0, rmpFileName.lastIndexOf("."))) + ".csv";
                        box.set(chooser.requestFileLocationInDetail(orgRmpFile.getParent(), csvFileName, "csv"));
                    }
                }
            });
        }
        catch (InvocationTargetException e) {
            e.printStackTrace();
        }
        catch (InterruptedException e) {
            e.printStackTrace();
        }
        outFile = (File)box.get();
        return outFile;
    }

    private void writeMeta(BufferedWriter writer, WorldMap map) throws IOException {
        ShelfNameManager shelfNameManager;
        Coord mapTl = map.tl();
        Coord mapBr = map.br();
        StringBuffer records = new StringBuffer();
        records.append(String.valueOf(Constants.MapCsvDataType.META.ordinal())).append(",").append(String.valueOf(Constants.MapCsvMetaType.BBOX.ordinal())).append(",").append(mapTl.x).append(",").append(mapTl.y).append(",").append(mapBr.x).append(",").append(mapBr.y);
        writer.write(records.toString());
        writer.newLine();
        ImageObject bgImg = map.bgImg();
        if (bgImg != null) {
            ByteArrayOutputStream bgImgOutputStream = new ByteArrayOutputStream();
            ImageIO.write((RenderedImage)bgImg.getImage(), "png", bgImgOutputStream);
            records = new StringBuffer();
            records.append(String.valueOf(Constants.MapCsvDataType.META.ordinal())).append(",").append(String.valueOf(Constants.MapCsvMetaType.BG_IMG.ordinal())).append(",").append(bgImg.left()).append(",").append(bgImg.top()).append(",").append(bgImg.right()).append(",").append(bgImg.bottom()).append(",").append(Base64.getEncoder().encodeToString(bgImgOutputStream.toByteArray()));
            writer.write(records.toString());
            writer.newLine();
        }
        if (!(shelfNameManager = map.shelfNameManager()).names().isEmpty()) {
            records = new StringBuffer();
            records.append(String.valueOf(Constants.MapCsvDataType.META.ordinal())).append(",").append(String.valueOf(Constants.MapCsvMetaType.SHELF_NAME_LIST.ordinal())).append(",");
            for (String name : shelfNameManager.names()) {
                records.append(name).append(",");
            }
            records.deleteCharAt(records.length() - 1);
            writer.write(records.toString());
            writer.newLine();
        }
    }

    private void writeShelf(BufferedWriter writer, AbstractObject object) throws IOException {
        FreeShelfObject freeShelfObject = (FreeShelfObject)object;
        StringBuffer records = new StringBuffer();
        records.append(String.valueOf(Constants.MapCsvDataType.OBJ.ordinal())).append(",").append(String.valueOf(Constants.MapCsvObjType.SHELF.ordinal())).append(",").append(freeShelfObject.left()).append(",").append(freeShelfObject.top()).append(",").append(freeShelfObject.right()).append(",").append(freeShelfObject.bottom()).append(",").append(freeShelfObject.shelf().name).append(",").append(freeShelfObject.getShelfColor().getAlpha()).append(",").append(freeShelfObject.getShelfColor().getRed()).append(",").append(freeShelfObject.getShelfColor().getGreen()).append(",").append(freeShelfObject.getShelfColor().getBlue());
        writer.write(records.toString());
        writer.newLine();
    }

    private void writeStation(BufferedWriter writer, AbstractObject object) throws IOException {
        StationObject stationObject = (StationObject)object;
        StringBuffer records = new StringBuffer();
        records.append(String.valueOf(Constants.MapCsvDataType.OBJ.ordinal())).append(",").append(String.valueOf(Constants.MapCsvObjType.STATION.ordinal())).append(",").append(stationObject.left()).append(",").append(stationObject.top()).append(",").append(stationObject.right()).append(",").append(stationObject.bottom());
        writer.write(records.toString());
        writer.newLine();
    }

    private void writeBeacon(BufferedWriter writer, AbstractObject object) throws IOException {
        BeaconObject beaconObject = (BeaconObject)object;
        StringBuffer records = new StringBuffer();
        records.append(String.valueOf(Constants.MapCsvDataType.OBJ.ordinal())).append(",").append(String.valueOf(Constants.MapCsvObjType.BEACON.ordinal())).append(",").append(beaconObject.point().x).append(",").append(beaconObject.point().y).append(",").append(beaconObject.beacon().beaconID).append(",").append(beaconObject.beacon().beaconName);
        writer.write(records.toString());
        writer.newLine();
    }

    private void writeWall(BufferedWriter writer, AbstractObject object) throws IOException {
        WallObject wallObject = (WallObject)object;
        StringBuffer records = new StringBuffer();
        records.append(String.valueOf(Constants.MapCsvDataType.OBJ.ordinal())).append(",").append(String.valueOf(Constants.MapCsvObjType.WALL.ordinal())).append(",").append(wallObject.left()).append(",").append(wallObject.top()).append(",").append(wallObject.right()).append(",").append(wallObject.bottom()).append(",").append(wallObject.height_mm());
        writer.write(records.toString());
        writer.newLine();
    }

    private void writeConstrainedArea(BufferedWriter writer, AbstractObject object) throws IOException {
        ConstrainedAreaObject constrainedAreaObject = (ConstrainedAreaObject)object;
        StringBuffer records = new StringBuffer();
        records.append(String.valueOf(Constants.MapCsvDataType.OBJ.ordinal())).append(",").append(String.valueOf(Constants.MapCsvObjType.CONSTRAINED_AREA.ordinal())).append(",").append(constrainedAreaObject.left()).append(",").append(constrainedAreaObject.top()).append(",").append(constrainedAreaObject.right()).append(",").append(constrainedAreaObject.bottom()).append(",").append(constrainedAreaObject.orientation()).append(",").append(constrainedAreaObject.trafficDirection()).append(",").append(constrainedAreaObject.splitPosition()).append(",").append(constrainedAreaObject.canEnterAExitA() ? 1 : 0).append(",").append(constrainedAreaObject.canEnterAExitB() ? 1 : 0).append(",").append(constrainedAreaObject.canEnterBExitA() ? 1 : 0).append(",").append(constrainedAreaObject.canEnterBExitB() ? 1 : 0);
        writer.write(records.toString());
        writer.newLine();
    }

    private void writeStairs(BufferedWriter writer, AbstractObject object) throws IOException {
        StairsObject stairsObject = (StairsObject)object;
        StringBuffer records = new StringBuffer();
        records.append(String.valueOf(Constants.MapCsvDataType.OBJ.ordinal())).append(",").append(String.valueOf(Constants.MapCsvObjType.STAIRS.ordinal())).append(",").append(stairsObject.left()).append(",").append(stairsObject.top()).append(",").append(stairsObject.right()).append(",").append(stairsObject.bottom()).append(",").append(stairsObject.getName());
        writer.write(records.toString());
        writer.newLine();
    }
}

